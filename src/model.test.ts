import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelOption, providerFromMessages, selectReviewerModel } from "./model.js";

const anthropic = { id: "haiku", providerID: "anthropic" };
const openai = { id: "mini", providerID: "openai" };
const fallback = { id: "cheap", providerID: "google" };

describe("parseModelOption", () => {
  it("returns undefined when unset", () => {
    assert.equal(parseModelOption(undefined), undefined);
  });

  it("keeps the legacy single-model form working", () => {
    const option = parseModelOption({ id: "x", providerID: "p", variant: "fast" });
    assert.deepEqual(option, { default: { id: "x", providerID: "p", variant: "fast" }, byProvider: {} });
  });

  it("parses default + byProvider", () => {
    const option = parseModelOption({ default: fallback, byProvider: { anthropic, openai } });
    assert.deepEqual(option, { default: fallback, byProvider: { anthropic, openai } });
  });

  it("allows byProvider without default", () => {
    assert.deepEqual(parseModelOption({ byProvider: { anthropic } }), {
      default: undefined,
      byProvider: { anthropic },
    });
  });

  it("rejects bad shapes with clear messages", () => {
    assert.throws(() => parseModelOption("gpt"), /"model" must be/);
    assert.throws(() => parseModelOption({ id: "x" }), /model\.providerID/);
    assert.throws(() => parseModelOption({ id: 3, providerID: "p" }), /model\.id/);
    assert.throws(() => parseModelOption({ id: "x", default: fallback }), /mixes/);
    assert.throws(() => parseModelOption({ byProvider: [] }), /byProvider" must be an object/);
    assert.throws(() => parseModelOption({ byProvider: { openai: { id: "m" } } }), /byProvider\.openai\.providerID/);
    assert.throws(() => parseModelOption({ default: "x" }), /model\.default must be an object/);
    assert.throws(() => parseModelOption({ other: 1 }), /unknown "model" key/);
  });
});

describe("selectReviewerModel", () => {
  const option = parseModelOption({ default: fallback, byProvider: { anthropic, openai } });

  it("uses the entry matching the main provider", () => {
    assert.deepEqual(selectReviewerModel(option, "openai"), openai);
    assert.deepEqual(selectReviewerModel(option, "anthropic"), anthropic);
  });

  it("falls back to default when no entry matches", () => {
    assert.deepEqual(selectReviewerModel(option, "mistral"), fallback);
  });

  it("falls back to default when the provider is unknown", () => {
    assert.deepEqual(selectReviewerModel(option, undefined), fallback);
  });

  it("does not match inherited object keys", () => {
    assert.deepEqual(selectReviewerModel(option, "toString"), fallback);
  });

  it("returns undefined (location default model) without default or match", () => {
    const noDefault = parseModelOption({ byProvider: { anthropic } });
    assert.equal(selectReviewerModel(noDefault, "openai"), undefined);
    assert.equal(selectReviewerModel(noDefault, undefined), undefined);
    assert.equal(selectReviewerModel(undefined, "openai"), undefined);
  });

  it("legacy form always returns the single model", () => {
    const legacy = parseModelOption({ id: "x", providerID: "p" });
    assert.deepEqual(selectReviewerModel(legacy, "openai"), { id: "x", providerID: "p" });
    assert.deepEqual(selectReviewerModel(legacy, undefined), { id: "x", providerID: "p" });
  });
});

describe("providerFromMessages", () => {
  it("takes the most recent message that carries a model", () => {
    const messages = [
      { type: "assistant", model: { id: "a", providerID: "anthropic" } },
      { type: "user", text: "hi" },
      { type: "model-switched", model: { id: "m", providerID: "openai" } },
      { type: "user", text: "again" },
    ];
    assert.equal(providerFromMessages(messages), "openai");
  });

  it("returns undefined when nothing carries a provider", () => {
    assert.equal(providerFromMessages([]), undefined);
    assert.equal(providerFromMessages([{ type: "user" }, null, "x"]), undefined);
  });
});
