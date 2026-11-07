import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseUsage } from "../lib/quota.mjs";
import { loadState, mutateState, statePath } from "../lib/state.mjs";

// 真实 `agy -p /usage --output-format json` 的输出（2026-11-07 采样）
const USAGE_JSON = JSON.stringify({
  conversation_id: "", status: "SUCCESS", response: "...", duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        { name: "Gemini Models", description: "", buckets: [
          { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.62, reset_time: "2026-11-14T05:43:29Z" },
          { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.1, reset_time: "2026-11-07T10:43:29Z" },
        ] },
        { name: "Claude and GPT models", description: "", buckets: [
          { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-14T05:43:29Z" },
          { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-07T10:43:29Z" },
        ] },
      ],
    },
  },
});

test("parseUsage maps groups and windows to families", () => {
  const s = parseUsage(USAGE_JSON, 123);
  assert.equal(s.at, 123);
  assert.deepEqual(s.gemini.fiveHour, { remaining: 0.1, resetAt: Date.parse("2026-11-07T10:43:29Z") });
  assert.deepEqual(s.gemini.weekly, { remaining: 0.62, resetAt: Date.parse("2026-11-14T05:43:29Z") });
  assert.equal(s.thirdparty.weekly.remaining, 1);
});

test("parseUsage tolerates leading noise and rejects garbage", () => {
  assert.ok(parseUsage(`warning: something\n${USAGE_JSON}\n`));
  assert.equal(parseUsage("Authentication required. Please visit the URL"), null);
  assert.equal(parseUsage("{}"), null);
  assert.equal(parseUsage(JSON.stringify({ command: { data: { groups: [{ name: "Gemini Models", buckets: [{ window: "5h" }] }] } } })), null);
});

test("state: legacy exhaustedUntil migrates to account cooldowns and roundtrips with 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-bridge-state-"));
  const env = { AGY_BRIDGE_STATE: join(dir, "state.json") };
  try {
    writeFileSync(statePath(env), JSON.stringify({ currentAccountId: "a", protected: ["m"], exhaustedUntil: { x: 111 } }));
    const migrated = loadState(env);
    assert.deepEqual(migrated.cooldowns.x, { until: 111, reason: "legacy" });
    assert.equal(migrated.exhaustedUntil, undefined);
    assert.deepEqual(migrated.protected, ["m"]);

    mutateState((s) => { s.banStrikes.y = 2; s.familyCooldowns.y = { gemini: 5 }; }, env);
    const saved = JSON.parse(readFileSync(statePath(env), "utf8"));
    assert.equal(saved.exhaustedUntil, undefined);
    assert.equal(saved.banStrikes.y, 2);
    assert.deepEqual(saved.cooldowns.x, { until: 111, reason: "legacy" });
    assert.equal(statSync(statePath(env)).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state: missing file yields an empty, well-formed state", () => {
  const env = { AGY_BRIDGE_STATE: join(tmpdir(), "agy-bridge-does-not-exist", "state.json") };
  const s = loadState(env);
  assert.deepEqual([s.cooldowns, s.familyCooldowns, s.banStrikes, s.quota], [{}, {}, {}, {}]);
  assert.deepEqual(s.protected, []);
});
