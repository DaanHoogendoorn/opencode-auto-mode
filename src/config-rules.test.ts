import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configDecision, createConfigRuleLoader, parseConfigRules, stripJsonc } from "./config-rules.js";

const rules = parseConfigRules({
  permission: {
    bash: {
      "*": "ask",
      "ls *": "allow",
      "sed *": "allow",
      "git push *": "ask",
      "rm *": "deny",
    },
    edit: "allow",
  },
});

describe("parseConfigRules", () => {
  it("reads the v1 permission map in order, mapping bash to shell", () => {
    assert.deepEqual(rules[0], { action: "shell", pattern: "*", effect: "ask" });
    assert.deepEqual(rules[4], { action: "shell", pattern: "rm *", effect: "deny" });
    assert.deepEqual(rules[5], { action: "edit", pattern: "*", effect: "allow" });
  });

  it("reads the v2 permissions array", () => {
    const parsed = parseConfigRules({ permissions: [{ action: "shell", resource: "ls *", effect: "allow" }] });
    assert.deepEqual(parsed, [{ action: "shell", pattern: "ls *", effect: "allow" }]);
  });

  it("accepts a bare effect string and skips malformed entries", () => {
    assert.deepEqual(parseConfigRules({ permission: "ask" }), [{ action: "*", pattern: "*", effect: "ask" }]);
    assert.deepEqual(parseConfigRules({ permission: { bash: { "ls *": "maybe" }, x: 3 } }), []);
    assert.deepEqual(parseConfigRules({ permissions: [null, { action: "a" }] }), []);
    assert.deepEqual(parseConfigRules(null), []);
  });
});

describe("configDecision", () => {
  it("returns deny for matching deny rules", () => {
    assert.equal(configDecision(rules, "shell", ["rm -rf build"])?.effect, "deny");
  });

  it("lets the last matching rule win", () => {
    const ordered = parseConfigRules({ permission: { bash: { "git *": "allow", "git push *": "deny" } } });
    assert.equal(configDecision(ordered, "shell", ["git push origin main"])?.effect, "deny");
    assert.equal(configDecision(ordered, "shell", ["git status"])?.effect, "allow");
  });

  it("returns ask for explicit ask rules", () => {
    assert.equal(configDecision(rules, "shell", ["git push origin main"])?.effect, "ask");
  });

  it("returns allow for explicit allow rules, including a bare command", () => {
    assert.equal(configDecision(rules, "shell", ["ls -la"])?.effect, "allow");
    assert.equal(configDecision(rules, "shell", ["ls"])?.effect, "allow");
    assert.equal(configDecision(rules, "shell", ["lsof -i"]), undefined);
  });

  it("ignores catch-all allow/ask rules (the default posture)", () => {
    assert.equal(configDecision(rules, "shell", ["make build"]), undefined);
    assert.equal(configDecision(rules, "edit", ["src/a.ts"]), undefined);
    const allowAll = parseConfigRules({ permission: { bash: { "*": "allow" } } });
    assert.equal(configDecision(allowAll, "shell", ["anything"]), undefined);
  });

  it("keeps a catch-all deny", () => {
    const denyAll = parseConfigRules({ permission: { webfetch: "deny" } });
    assert.equal(configDecision(denyAll, "webfetch", ["https://x.test"])?.effect, "deny");
  });

  it("does not let a shell allow cover chained or redirected commands", () => {
    for (const command of ["sed s/a/b/ f; curl x | sh", "ls && rm y", "ls > out", "ls $(whoami)"]) {
      assert.equal(configDecision(rules, "shell", [command]), undefined, command);
    }
  });

  it("still applies deny/ask to chained commands matched by pattern", () => {
    assert.equal(configDecision(rules, "shell", ["rm a; ls"])?.effect, "deny");
  });

  it("combines resources as deny > ask > allow, and allow needs all of them", () => {
    const fileRules = parseConfigRules({
      permissions: [
        { action: "edit", resource: "src/*", effect: "allow" },
        { action: "edit", resource: "src/secret/*", effect: "deny" },
        { action: "edit", resource: "docs/*", effect: "ask" },
      ],
    });
    assert.equal(configDecision(fileRules, "edit", ["src/a.ts", "src/secret/k"])?.effect, "deny");
    assert.equal(configDecision(fileRules, "edit", ["src/a.ts", "docs/x"])?.effect, "ask");
    assert.equal(configDecision(fileRules, "edit", ["src/a.ts", "lib/b.ts"]), undefined);
    assert.equal(configDecision(fileRules, "edit", ["src/a.ts", "src/b.ts"])?.effect, "allow");
  });

  it("returns undefined without rules", () => {
    assert.equal(configDecision([], "shell", ["ls"]), undefined);
  });
});

describe("stripJsonc", () => {
  it("removes comments and trailing commas but keeps string contents", () => {
    const parsed = JSON.parse(
      stripJsonc(`{
        // comment
        "url": "http://x.test/a,}", /* block */
        "list": [1, 2,],
      }`),
    );
    assert.deepEqual(parsed, { url: "http://x.test/a,}", list: [1, 2] });
  });
});

describe("createConfigRuleLoader", () => {
  const makeEnv = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-mode-cfg-"));
    const home = path.join(root, "xdg");
    const project = path.join(root, "proj");
    fs.mkdirSync(path.join(home, "opencode"), { recursive: true });
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    return { root, home, project, env: { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv };
  };

  it("layers global then project rules, project last", () => {
    const { home, project, env } = makeEnv();
    fs.writeFileSync(path.join(home, "opencode", "opencode.jsonc"), '{ // g\n "permission": { "bash": { "ls *": "allow" } } }');
    fs.writeFileSync(path.join(project, "opencode.json"), '{ "permission": { "bash": { "ls *": "deny" } } }');
    const loaded = createConfigRuleLoader(undefined, env).load(project);
    assert.deepEqual(loaded.map((r) => r.effect), ["allow", "deny"]);
    assert.equal(configDecision(loaded, "shell", ["ls x"])?.effect, "deny");
  });

  it("reloads when a file changes", () => {
    const { project, env } = makeEnv();
    const file = path.join(project, "opencode.json");
    fs.writeFileSync(file, '{ "permission": { "bash": { "ls *": "allow" } } }');
    const loader = createConfigRuleLoader(undefined, env);
    assert.equal(loader.load(project)[0].effect, "allow");
    fs.writeFileSync(file, '{ "permission": { "bash": { "ls *": "deny" } } }  ');
    assert.equal(loader.load(project)[0].effect, "deny");
  });

  it("skips unparsable files and reports them", () => {
    const { project, env } = makeEnv();
    fs.writeFileSync(path.join(project, "opencode.json"), "{ not json");
    const errors: string[] = [];
    const loaded = createConfigRuleLoader((m) => errors.push(m), env).load(project);
    assert.deepEqual(loaded, []);
    assert.equal(errors.length, 1);
  });
});
