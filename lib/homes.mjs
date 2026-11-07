/**
 * 私有 HOME：每个账号一个独立目录（~/.agy-bridge/homes/<id>），里面放该账号自己的 agy 登录文件。
 * agy 在这样的 HOME 下找不到钥匙串，会改用文件凭据，所以可以按进程选账号、
 * 不碰全局钥匙串，也不影响当前正在服务的那个号。
 *
 * 实测（2026-11-07）：空 HOME → Authentication required；放入过期 access_token +
 * 有效 refresh_token 的凭据 → agy 自行刷新并写回该文件，系统钥匙串条目指纹前后一致。
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findAgy } from "./agy.mjs";
import { payloadFor, writeSessionFileAt } from "./credstore.mjs";
import { ensureFresh } from "./oauth.mjs";
import { readUsage } from "./quota.mjs";
import { mutateState } from "./state.mjs";
import { patchAccount, readAccount } from "./vault.mjs";
import { log } from "./util.mjs";

export function homesRoot(env = process.env) {
  return env.AGY_BRIDGE_HOMES ?? join(homedir(), ".agy-bridge", "homes");
}

/** 准备好某账号的私有 HOME，返回目录。token 过期会先用 refresh_token 刷新并回写金库。 */
export async function preparePrivateHome(accountId, env = process.env) {
  const account = readAccount(accountId);
  const token = await ensureFresh(account.token);
  if (token !== account.token) patchAccount(accountId, { token });
  const home = join(homesRoot(env), accountId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const sessionDir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeSessionFileAt(join(sessionDir, "antigravity-oauth-token"), payloadFor(token));
  return home;
}

// 额度读取串行执行：同一时刻最多一个 agy -p，避免并发拉起多个 hub
let queue = Promise.resolve();
const inflight = new Map();

/** 读取并保存某账号的额度快照到 state.quota。同一账号并发调用共享同一次读取。 */
export function refreshQuota(accountId, { agyBin = findAgy() } = {}) {
  const existing = inflight.get(accountId);
  if (existing) return existing;
  const job = queue.then(async () => {
    const home = await preparePrivateHome(accountId);
    const snapshot = await readUsage({ agyBin, home });
    mutateState((state) => { state.quota[accountId] = snapshot; });
    return snapshot;
  });
  queue = job.catch(() => {});
  const tracked = job.finally(() => inflight.delete(accountId));
  inflight.set(accountId, tracked);
  tracked.catch((error) => log(`quota refresh failed for ${accountId.slice(0, 8)}: ${error.message}`));
  return tracked;
}
