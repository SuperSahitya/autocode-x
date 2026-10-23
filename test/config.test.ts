import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, resolveModelSpec } from "../src/config.js";

const config = { ...loadConfig(), defaultProfile: "ollama" };

test("model spec: profile, profile:model, bare model", () => {
  assert.equal(resolveModelSpec(config, "gemini").profile.model, "gemini-3.5-flash-lite");

  const groq = resolveModelSpec(config, "groq:llama-3.3-70b-versatile");
  assert.equal(groq.name, "groq");
  assert.equal(groq.profile.model, "llama-3.3-70b-versatile");

  const bare = resolveModelSpec(config, "gemini-3.6-flash", "gemini");
  assert.equal(bare.name, "gemini");
  assert.equal(bare.profile.model, "gemini-3.6-flash");
});

test("model spec: ollama tags with colons stay intact", () => {
  const r = resolveModelSpec(config, "qwen2.5-coder:32b");
  assert.equal(r.name, "ollama");
  assert.equal(r.profile.model, "qwen2.5-coder:32b");
});

test("model spec: unknown profile is an error", () => {
  assert.throws(() => resolveModelSpec(config, undefined, "nope"), /Unknown profile/);
});
