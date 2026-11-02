import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasShellMetacharacters } from "./tiers.js";

export type Effect = "allow" | "deny" | "ask";

export interface ConfigRule {
  action: string;
  pattern: string;
  effect: Effect;
}

export interface ConfigDecision {
  effect: Effect;
  reason: string;
}

const EFFECTS = new Set<string>(["allow", "deny", "ask"]);

// v1 configs name the shell tool "bash"; the v2 hook reports it as "shell".
const ACTION_ALIASES: Record<string, string> = { bash: "shell" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEffect(value: unknown): value is Effect {
  return typeof value === "string" && EFFECTS.has(value);
}

function normalizeAction(action: string): string {
  return ACTION_ALIASES[action] ?? action;
}

/**
 * Extracts rules, in declaration order (last match wins), from one parsed
 * opencode.json document. Understands the v1 `permission` map
 * (`{ bash: { "ls *": "allow" } }`) and the v2 `permissions` array
 * (`[{ action, resource, effect }]`). Malformed entries are skipped.
 */
export function parseConfigRules(document: unknown): ConfigRule[] {
  if (!isRecord(document)) return [];
  const rules: ConfigRule[] = [];

  const v1 = document.permission;
  if (isEffect(v1)) rules.push({ action: "*", pattern: "*", effect: v1 });
  if (isRecord(v1)) {
    for (const [action, value] of Object.entries(v1)) {
      if (isEffect(value)) {
        rules.push({ action: normalizeAction(action), pattern: "*", effect: value });
        continue;
      }
      if (!isRecord(value)) continue;
      for (const [pattern, effect] of Object.entries(value)) {
        if (isEffect(effect)) rules.push({ action: normalizeAction(action), pattern, effect });
      }
    }
  }

  const v2 = document.permissions;
  if (Array.isArray(v2)) {
    for (const rule of v2) {
      if (!isRecord(rule)) continue;
      const { action, resource, effect } = rule;
      if (typeof action !== "string" || typeof resource !== "string" || !isEffect(effect)) continue;
      rules.push({ action: normalizeAction(action), pattern: resource, effect });
    }
  }

  return rules;
}

function expandHome(pattern: string): string {
  if (pattern === "~" || pattern.startsWith("~/")) return os.homedir() + pattern.slice(1);
  if (pattern === "$HOME" || pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5);
  return pattern;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = expandHome(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  // "ls *" also matches a bare "ls", like the host's argument wildcard.
  const withOptionalArgs = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped;
  return new RegExp(`^${withOptionalArgs}$`, "s");
}

function matches(pattern: string, value: string): boolean {
  return pattern === "*" || wildcardToRegExp(pattern).test(value);
}

interface ResourceVerdict {
  effect: Effect;
  catchAll: boolean;
}

function lastMatch(rules: readonly ConfigRule[], action: string, resource: string): ResourceVerdict | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (matches(rule.action, action) && matches(rule.pattern, resource)) {
      return { effect: rule.effect, catchAll: rule.pattern === "*" };
    }
  }
  return undefined;
}

/**
 * What the user's own rules say about this request, or undefined when they
 * have nothing specific to say. Combination across resources is
 * deny > ask > allow, and `allow` requires every resource to be allowed.
 *
 * Catch-all (`*`) allow/ask rules are the user's default posture, not a
 * considered verdict, so they are ignored here: a `"*": "ask"` baseline would
 * otherwise stop the reviewer from ever running. Catch-all deny is kept.
 *
 * A shell `allow` never applies to chained/redirected commands: a pattern like
 * `sed *` also matches `sed x; rm -rf y`, so those still reach the reviewer.
 */
export function configDecision(
  rules: readonly ConfigRule[],
  action: string,
  resources: readonly string[],
): ConfigDecision | undefined {
  if (rules.length === 0) return undefined;

  const targets = resources.length > 0 ? resources : [""];
  const verdicts = targets.map((resource) => lastMatch(rules, action, resource));

  if (verdicts.some((v) => v?.effect === "deny")) {
    return { effect: "deny", reason: "denied by your opencode.json permission rules" };
  }
  if (verdicts.some((v) => v?.effect === "ask" && !v.catchAll)) {
    return { effect: "ask", reason: "your opencode.json permission rules require asking" };
  }

  const allAllowed = verdicts.every((v) => v?.effect === "allow" && !v.catchAll);
  if (!allAllowed) return undefined;
  if (action === "shell" && targets.some((command) => hasShellMetacharacters(command))) return undefined;
  return { effect: "allow", reason: "allowed by your opencode.json permission rules" };
}

/** Strips comments and trailing commas so JSONC parses with JSON.parse. */
export function stripJsonc(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") out += source[++i] ?? "";
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
    } else {
      out += char;
    }
  }

  let result = "";
  inString = false;
  for (let i = 0; i < out.length; i++) {
    const char = out[i];
    if (inString) {
      result += char;
      if (char === "\\") result += out[++i] ?? "";
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ",") {
      const following = out.slice(i + 1).match(/^\s*([}\]])/);
      if (following) continue;
    }
    result += char;
  }
  return result;
}

const FILE_NAMES = ["opencode.json", "opencode.jsonc"];

function candidateFiles(projectDir: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const files = FILE_NAMES.map((name) => path.join(configHome, "opencode", name));
  if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG);
  if (!projectDir) return files;

  // Walk up to the repo root (or filesystem root); outermost first so the
  // innermost config wins, like the rest of the layering.
  const dirs: string[] = [];
  let dir = path.resolve(projectDir);
  for (;;) {
    dirs.unshift(dir);
    if (fs.existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of dirs) {
    for (const name of FILE_NAMES) files.push(path.join(d, name), path.join(d, ".opencode", name));
  }
  return files;
}

export interface ConfigRuleLoader {
  load(projectDir: string | undefined): ConfigRule[];
}

/**
 * Reads the user's opencode.json(c) files directly — the v2 plugin context
 * exposes no config API. Parsed rules are cached per project and reloaded when
 * any candidate file's mtime/size changes. Unreadable or unparsable files are
 * skipped (behaving as if they set no rules) and reported through `onError`.
 */
export function createConfigRuleLoader(
  onError: (message: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
): ConfigRuleLoader {
  const cache = new Map<string, { signature: string; rules: ConfigRule[] }>();

  return {
    load(projectDir) {
      const files = candidateFiles(projectDir, env);
      const stats = files.map((file) => {
        try {
          const stat = fs.statSync(file);
          return stat.isFile() ? { file, stamp: `${stat.mtimeMs}:${stat.size}` } : undefined;
        } catch {
          return undefined;
        }
      });
      const existing = stats.filter((s): s is { file: string; stamp: string } => s !== undefined);
      const signature = existing.map((s) => `${s.file}@${s.stamp}`).join("|");

      const key = projectDir ?? "";
      const cached = cache.get(key);
      if (cached?.signature === signature) return cached.rules;

      const rules: ConfigRule[] = [];
      for (const { file } of existing) {
        try {
          rules.push(...parseConfigRules(JSON.parse(stripJsonc(fs.readFileSync(file, "utf8")))));
        } catch (err) {
          onError(`could not read permission rules from ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      cache.set(key, { signature, rules });
      return rules;
    },
  };
}
