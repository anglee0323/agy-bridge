/**
 * 额度快照与后台刷新节奏。
 *
 * 背景：桥原本只在真正服务过请求后才顺带查一次额度，闲置时 state.quota 会一直停在
 * 上次使用时刻，任何读 state 的看板都只能显示几天前的数字。这里锁住三件事：
 *   1) quotaSnapshot() 如实报出当前号的快照和年龄（不触发任何请求）；
 *   2) 没有当前号时不伪造数据；
 *   3) startQuotaRefresh(0) 不装计时器（可关闭），正数才装。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "agy-quota-refresh-"));
process.env.AGY_BRIDGE_STATE = join(dir, "state.json");

const { Runtime } = await import("../lib/runtime.mjs");

const cfg = {
  agyBin: "agy",
  home: join(dir, "agent"),
  defaultEffort: "high",
  maxLiveSessions: 1,
  idleTtlMs: 60_000,
  parkedTtlMs: 60_000,
  parkSettleMs: 0,
  relayAfterMs: 60_000,
  maxRelays: 0,
  maxContinuations: 0,
  keepAliveMs: 0,
  autoSwitch: false,
  mcpPort: 0,
};

function writeState(value) {
  writeFileSync(process.env.AGY_BRIDGE_STATE, JSON.stringify(value));
}

test("quotaSnapshot reports the current account snapshot and its age", async () => {
  const at = Date.now() - 5 * 60_000;
  writeState({
    currentAccountId: "acc-1",
    protected: [],
    cooldowns: {},
    familyCooldowns: {},
    banStrikes: {},
    quota: { "acc-1": { at, gemini: { weekly: { remaining: 0.5, resetAt: at + 86_400_000 } } } },
  });
  const rt = new Runtime(cfg);
  try {
    const snap = rt.quotaSnapshot();
    assert.equal(snap.account, "acc-1");
    assert.equal(snap.at, at);
    assert.ok(snap.ageMs >= 5 * 60_000, `ageMs=${snap.ageMs}`);
    assert.equal(snap.quota.gemini.weekly.remaining, 0.5);
  } finally {
    await rt.dispose();
  }
});

test("quotaSnapshot does not invent data when the current account has no snapshot", async () => {
  writeState({
    currentAccountId: "acc-2",
    protected: [],
    cooldowns: {},
    familyCooldowns: {},
    banStrikes: {},
    quota: {},
  });
  const rt = new Runtime(cfg);
  try {
    const snap = rt.quotaSnapshot();
    assert.equal(snap.account, "acc-2");
    assert.equal(snap.at, null);
    assert.equal(snap.ageMs, null);
    assert.equal(snap.quota, null);
  } finally {
    await rt.dispose();
  }
});

test("quotaSnapshot is empty when no account is selected", async () => {
  writeState({
    currentAccountId: null,
    protected: [],
    cooldowns: {},
    familyCooldowns: {},
    banStrikes: {},
    quota: { "acc-1": { at: 1 } },
  });
  const rt = new Runtime(cfg);
  try {
    const snap = rt.quotaSnapshot();
    assert.equal(snap.account, null);
    assert.equal(snap.quota, null);
  } finally {
    await rt.dispose();
  }
});

test("startQuotaRefresh(0) installs no timer, a positive interval does", async () => {
  writeState({ currentAccountId: null, protected: [], cooldowns: {}, familyCooldowns: {}, banStrikes: {}, quota: {} });
  const rt = new Runtime(cfg);
  try {
    rt.startQuotaRefresh(0);
    assert.equal(rt.quotaRefreshTimer, null, "0 应关闭后台刷新");
    rt.startQuotaRefresh(60_000);
    assert.ok(rt.quotaRefreshTimer, "正数间隔应装上计时器");
    // 重复调用不叠加
    const first = rt.quotaRefreshTimer;
    rt.startQuotaRefresh(60_000);
    assert.equal(rt.quotaRefreshTimer, first);
  } finally {
    await rt.dispose();
  }
});
