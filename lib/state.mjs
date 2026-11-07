/**
 * 桥的运行状态（~/.cache/agy-bridge/state.json，0600）。
 * 守护进程与 CLI 都会读写，所以不缓存：每次决策前现读，修改走 mutateState（读-改-原子写）。
 *
 *   currentAccountId   当前登录槽位对应的金库账号
 *   protected          永不自动切入的账号 ID
 *   cooldowns          账号级冷却 { [id]: { until, reason: banned|auth|legacy } }
 *   familyCooldowns    模型族级冷却 { [id]: { gemini?: until, thirdparty?: until } }
 *   banStrikes         连续被封次数，决定下一次复测的间隔
 *   quota              最近一次读到的额度快照 { [id]: Snapshot }（见 pool.mjs）
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function statePath(env = process.env) {
  return env.AGY_BRIDGE_STATE ?? join(homedir(), ".cache", "agy-bridge", "state.json");
}

function empty() {
  return { currentAccountId: null, protected: [], cooldowns: {}, familyCooldowns: {}, banStrikes: {}, quota: {} };
}

export function loadState(env = process.env) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(statePath(env), "utf8"));
  } catch {
    raw = {};
  }
  const state = { ...empty(), ...raw };
  // 旧版字段 exhaustedUntil（单一固定冷却）迁移为账号级冷却
  if (raw.exhaustedUntil && typeof raw.exhaustedUntil === "object") {
    for (const [id, until] of Object.entries(raw.exhaustedUntil)) {
      if (!state.cooldowns[id]) state.cooldowns[id] = { until, reason: "legacy" };
    }
  }
  delete state.exhaustedUntil;
  delete state.updatedAt;
  return state;
}

export function saveState(state, env = process.env) {
  const path = statePath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.state.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** 读-改-原子写。fn 可就地修改 state，返回值原样传出。 */
export function mutateState(fn, env = process.env) {
  const state = loadState(env);
  const result = fn(state);
  saveState(state, env);
  return result;
}
