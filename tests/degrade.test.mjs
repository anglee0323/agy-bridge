import assert from "node:assert/strict";
import { test } from "node:test";
import { degradationSignals } from "../lib/degrade.mjs";

test("no thinking at high effort plus fast decode is flagged", () => {
  const verdict = degradationSignals({ effort: "high", usage: { completion: 400, reasoning: 0 }, decodeMs: 2_000, textChars: 1_200 });
  assert.equal(verdict.degraded, true);
  assert.deepEqual(verdict.signals, ["no_thinking", "fast_decode"]);
});

test("normal high-effort turn with thinking is not flagged", () => {
  const verdict = degradationSignals({ effort: "high", usage: { completion: 800, reasoning: 3_000 }, decodeMs: 60_000, textChars: 3_000 });
  assert.equal(verdict.degraded, false);
  assert.deepEqual(verdict.signals, []);
});

test("a short answer without thinking stays below the threshold", () => {
  const verdict = degradationSignals({ effort: "high", usage: { completion: 30, reasoning: 0 }, decodeMs: 0, textChars: 100 });
  assert.equal(verdict.degraded, false);
  assert.deepEqual(verdict.signals, ["short_output"]);
});

test("fast decode alone is not enough", () => {
  const verdict = degradationSignals({ effort: "medium", usage: { completion: 400, reasoning: 0 }, decodeMs: 2_000, textChars: 1_200 });
  assert.equal(verdict.degraded, false);
  assert.deepEqual(verdict.signals, ["fast_decode"]);
});
