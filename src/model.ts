export interface ReviewerModel {
  id: string;
  providerID: string;
  variant?: string;
}

export interface ModelOption {
  default?: ReviewerModel;
  byProvider: Record<string, ReviewerModel>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelRef(value: unknown, where: string): ReviewerModel {
  if (!isRecord(value)) {
    throw new Error(`opencode-auto-mode: ${where} must be an object like { "id": "...", "providerID": "..." }`);
  }
  const { id, providerID, variant } = value;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`opencode-auto-mode: ${where}.id must be a non-empty string`);
  }
  if (typeof providerID !== "string" || providerID.length === 0) {
    throw new Error(`opencode-auto-mode: ${where}.providerID must be a non-empty string`);
  }
  if (variant !== undefined && typeof variant !== "string") {
    throw new Error(`opencode-auto-mode: ${where}.variant must be a string when set`);
  }
  return variant === undefined ? { id, providerID } : { id, providerID, variant };
}

/**
 * Accepts the legacy single `{ id, providerID }` form and the
 * `{ default, byProvider }` form. Throws a descriptive error on bad shapes.
 */
export function parseModelOption(raw: unknown): ModelOption | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (!isRecord(raw)) {
    throw new Error(
      'opencode-auto-mode: "model" must be { id, providerID } or { default?, byProvider? }',
    );
  }

  const isLegacy = "id" in raw || "providerID" in raw;
  const isMapped = "default" in raw || "byProvider" in raw;

  if (isLegacy && isMapped) {
    throw new Error(
      'opencode-auto-mode: "model" mixes { id, providerID } with { default, byProvider }; use one form',
    );
  }

  if (isLegacy) return { default: parseModelRef(raw, "model"), byProvider: {} };

  const unknownKeys = Object.keys(raw).filter((key) => key !== "default" && key !== "byProvider");
  if (unknownKeys.length > 0) {
    throw new Error(`opencode-auto-mode: unknown "model" key(s): ${unknownKeys.join(", ")}`);
  }

  const byProviderRaw = raw.byProvider;
  if (byProviderRaw !== undefined && !isRecord(byProviderRaw)) {
    throw new Error('opencode-auto-mode: "model.byProvider" must be an object keyed by provider ID');
  }

  const byProvider: Record<string, ReviewerModel> = {};
  for (const [provider, entry] of Object.entries(byProviderRaw ?? {})) {
    byProvider[provider] = parseModelRef(entry, `model.byProvider.${provider}`);
  }

  const fallback = raw.default === undefined ? undefined : parseModelRef(raw.default, "model.default");
  return { default: fallback, byProvider };
}

/**
 * Provider match first, then `default`, then undefined (the caller passes
 * null so the location default model is used, as before).
 */
export function selectReviewerModel(
  option: ModelOption | undefined,
  providerID: string | undefined,
): ReviewerModel | undefined {
  if (!option) return undefined;
  const matched =
    providerID !== undefined && Object.hasOwn(option.byProvider, providerID)
      ? option.byProvider[providerID]
      : undefined;
  return matched ?? option.default;
}

/** Best-effort provider extraction from loosely typed session messages. */
export function providerFromMessages(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message)) continue;
    const model = message.model;
    if (!isRecord(model)) continue;
    if (typeof model.providerID === "string" && model.providerID.length > 0) return model.providerID;
  }
  return undefined;
}
