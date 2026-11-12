import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSessions, rememberSession, saveSessions } from "../lib/sessions.mjs";

function env() {
  const dir = mkdtempSync(join(tmpdir(), "agy-bridge-sessions-"));
  return { AGY_BRIDGE_SESSIONS: join(dir, "sessions.json") };
}

const record = (sessionId, extra = {}) => ({
  sessionId,
  sysHash: "sys",
  toolsHash: "tools",
  fps: ["u:1"],
  mcpPort: 8790,
  updatedAt: Date.now(),
  ...extra,
});

test("sessions: roundtrip keeps records and writes 0600", () => {
  const e = env();
  const sessions = {};
  rememberSession(sessions, "k1", record("s1"), e);
  const loaded = loadSessions(e);
  assert.deepEqual(Object.keys(loaded), ["k1"]);
  assert.equal(loaded.k1.sessionId, "s1");
  assert.equal(statSync(e.AGY_BRIDGE_SESSIONS).mode & 0o777, 0o600);
});

test("sessions: stale records are dropped on load", () => {
  const e = env();
  saveSessions({ old: record("s1", { updatedAt: Date.now() - 25 * 3600_000 }), fresh: record("s2") }, e);
  assert.deepEqual(Object.keys(loadSessions(e)), ["fresh"]);
});

test("sessions: malformed records are ignored", () => {
  const e = env();
  saveSessions({ bad: { sessionId: 1 }, noFps: { sessionId: "s", fps: "x" }, ok: record("s3") }, e);
  assert.deepEqual(Object.keys(loadSessions(e)), ["ok"]);
});

test("sessions: the ledger keeps at most 32 entries, newest first", () => {
  const e = env();
  const sessions = {};
  for (let i = 0; i < 40; i++) rememberSession(sessions, `k${i}`, record(`s${i}`, { updatedAt: Date.now() + i }), e);
  const loaded = loadSessions(e);
  assert.equal(Object.keys(loaded).length, 32);
  assert.ok(loaded.k39);
  assert.ok(!loaded.k0);
});

test("sessions: a missing file yields an empty ledger", () => {
  assert.deepEqual(loadSessions(env()), {});
});
