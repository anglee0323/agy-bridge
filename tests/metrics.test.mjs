import assert from "node:assert/strict";
import { test } from "node:test";
import { prometheus } from "../lib/metrics.mjs";

const health = {
  status: "ready",
  autoSwitch: true,
  pool: [{ name: "a", current: true, blocked: { gemini: { reason: "quota", minutes: 30 } } }, { name: "b" }],
  sessions: [{ busy: true }, { busy: false }],
  stats: { requests: 3, rebuilds: 1, appends: 2, resumes: 4, toolCalls: 5, errors: 0, aborts: 1, degradedTurns: 2 },
  degraded: { signals: { no_thinking: 2, fast_decode: 2 } },
  models: ["gemini-3.8-flash", "claude-sonnet-4-6"],
};

test("prometheus exports counters, gauges and degrade signals", () => {
  const text = prometheus(health);
  assert.match(text, /^# HELP agy_bridge_up /m);
  assert.match(text, /^agy_bridge_up 1$/m);
  assert.match(text, /^agy_bridge_requests_total 3$/m);
  assert.match(text, /^agy_bridge_degraded_turns_total 2$/m);
  assert.match(text, /^agy_bridge_sessions 2$/m);
  assert.match(text, /^agy_bridge_sessions_busy 1$/m);
  assert.match(text, /^agy_bridge_accounts_blocked 1$/m);
  assert.match(text, /^agy_bridge_models 2$/m);
  assert.match(text, /^agy_bridge_degrade_signals_total\{signal="no_thinking"\} 2$/m);
});

test("prometheus reports an idle bridge as down", () => {
  const text = prometheus({ ...health, status: "idle", stats: {}, pool: [], sessions: [], models: [], degraded: {} });
  assert.match(text, /^agy_bridge_up 0$/m);
  assert.match(text, /^agy_bridge_requests_total 0$/m);
});
