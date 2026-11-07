import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountBlock, banCooldownMs, blockedUntil, classifyAccountError, classifyNotice, familyOf, pickNext,
} from "../lib/pool.mjs";

const NOW = Date.parse("2026-11-07T06:00:00Z");
const HOUR = 3600_000;
const snap = (gemini, thirdparty) => ({ at: NOW, ...(gemini ? { gemini } : {}), ...(thirdparty ? { thirdparty } : {}) });
const win = (remaining, hoursToReset) => ({ remaining, resetAt: NOW + hoursToReset * HOUR });

test("familyOf maps model ids to quota families", () => {
  assert.equal(familyOf("gemini-3.8-flash"), "gemini");
  assert.equal(familyOf("claude-sonnet-4-6"), "thirdparty");
  assert.equal(familyOf("gpt-oss-120b-medium"), "thirdparty");
});

test("blockedUntil: 5h window blocks strictly below 15%", () => {
  assert.equal(blockedUntil(snap({ fiveHour: win(0.14, 3) }), "gemini", NOW), NOW + 3 * HOUR);
  assert.equal(blockedUntil(snap({ fiveHour: win(0.15, 3) }), "gemini", NOW), 0);
});

test("blockedUntil: weekly window blocks at or below 1%", () => {
  assert.equal(blockedUntil(snap({ weekly: win(0.01, 48) }), "gemini", NOW), NOW + 48 * HOUR);
  assert.equal(blockedUntil(snap({ weekly: win(0.02, 48) }), "gemini", NOW), 0);
});

test("blockedUntil: both exhausted -> later reset; passed reset -> recovered; other family unaffected", () => {
  const s = snap({ fiveHour: win(0, 2), weekly: win(0, 40) }, { fiveHour: win(1, 4), weekly: win(1, 100) });
  assert.equal(blockedUntil(s, "gemini", NOW), NOW + 40 * HOUR);
  assert.equal(blockedUntil(s, "thirdparty", NOW), 0);
  assert.equal(blockedUntil(snap({ fiveHour: win(0, -1) }), "gemini", NOW), 0);
  assert.equal(blockedUntil(undefined, "gemini", NOW), 0);
});

test("banCooldownMs doubles from 2h and caps at 24h", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => banCooldownMs(n) / HOUR), [2, 4, 8, 16, 24, 24]);
  assert.equal(banCooldownMs(0) / HOUR, 2);
});

test("accountBlock reports account cooldown, family cooldown and quota separately", () => {
  const state = {
    cooldowns: { a: { until: NOW + HOUR, reason: "banned" }, b: { until: NOW - 1, reason: "banned" } },
    familyCooldowns: { c: { gemini: NOW + HOUR } },
    quota: { d: snap({ fiveHour: win(0.05, 2) }) },
  };
  assert.deepEqual(accountBlock("a", "gemini", state, NOW), { blocked: true, until: NOW + HOUR, reason: "banned" });
  assert.equal(accountBlock("b", "gemini", state, NOW).blocked, false, "expired cooldown no longer blocks");
  assert.equal(accountBlock("c", "gemini", state, NOW).blocked, true);
  assert.equal(accountBlock("c", "thirdparty", state, NOW).blocked, false, "cooldown is scoped to the family");
  assert.equal(accountBlock("d", "gemini", state, NOW).reason, "quota");
});

test("pickNext skips disabled, protected, excluded and blocked accounts", () => {
  const accounts = [
    { id: "main", lastUsed: 1 },
    { id: "off", lastUsed: 2, disabled: true },
    { id: "cur", lastUsed: 3 },
    { id: "cool", lastUsed: 4 },
    { id: "ok", lastUsed: 5 },
  ];
  const state = { protected: ["main"], cooldowns: { cool: { until: NOW + HOUR, reason: "banned" } }, familyCooldowns: {}, quota: {} };
  assert.equal(pickNext(accounts, state, { family: "gemini", excludeId: "cur", now: NOW }).id, "ok");
  assert.equal(pickNext([accounts[0], accounts[1]], state, { family: "gemini", now: NOW }), null);
});

test("pickNext prefers the soonest weekly reset (use it or lose it), then least recently used", () => {
  const accounts = [
    { id: "fresh", lastUsed: 1 },
    { id: "used", lastUsed: 99 },
    { id: "unknown", lastUsed: 0 },
  ];
  const state = {
    protected: [], cooldowns: {}, familyCooldowns: {},
    quota: { fresh: snap({ weekly: win(1, 168) }), used: snap({ weekly: win(0.4, 30) }) },
  };
  assert.equal(pickNext(accounts, state, { family: "gemini", now: NOW }).id, "used");
  delete state.quota.used;
  assert.equal(pickNext(accounts, state, { family: "gemini", now: NOW }).id, "fresh", "known reset beats unknown");
  state.quota = {};
  assert.equal(pickNext(accounts, state, { family: "gemini", now: NOW }).id, "unknown", "ties fall back to least recently used");
});

test("a family cooldown only hides the account from that family", () => {
  const accounts = [{ id: "a", lastUsed: 1 }, { id: "b", lastUsed: 2 }];
  const state = { protected: [], cooldowns: {}, familyCooldowns: { a: { thirdparty: NOW + HOUR } }, quota: {} };
  assert.equal(pickNext(accounts, state, { family: "thirdparty", now: NOW }).id, "b");
  assert.equal(pickNext(accounts, state, { family: "gemini", now: NOW }).id, "a");
});

test("classifyAccountError", () => {
  assert.equal(classifyAccountError("This service has been disabled in this account for violation of Terms of Service."), "banned");
  assert.equal(classifyAccountError("RESOURCE_EXHAUSTED (code 429): quota exceeded"), "quota");
  assert.equal(classifyAccountError("You have exhausted your quota on this model."), "quota");
  assert.equal(classifyAccountError("PERMISSION_DENIED (code 429) too many requests"), "rate");
  assert.equal(classifyAccountError("Antigravity requires sign-in: Authentication required"), "auth");
  assert.equal(classifyAccountError("Your input exceeds the context window of this model"), null);
  assert.equal(classifyAccountError("agy acp exited (code=1)"), null);
});

test("classifyNotice only fires on short notice-like text, never on ordinary discussion", () => {
  assert.equal(classifyNotice("\n\u26a0 This service has been disabled in this account for violation of Terms of Service. Please submit an appeal."), "banned");
  assert.equal(classifyNotice("\u26a0 You have exhausted your quota on this model."), "quota");
  assert.equal(classifyNotice("HTTP 429 means Too Many Requests; clients should back off."), null);
  assert.equal(classifyNotice("RESOURCE_EXHAUSTED is the gRPC status used for quota errors, as in: x".padEnd(500, " x")), null);
  assert.equal(classifyNotice("To handle quota errors, check whether you have exhausted your quota first."), null);
  assert.equal(classifyNotice(""), null);
});
