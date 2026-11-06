/**
 * 切号编排，移植 agy-switch 的 switch_account 主链路（macOS、agy CLI 目标）：
 *   锁 → 目标 token 刷新（失败则零写入中止）→ 回写金库 → 写钥匙串+会话文件
 * 每次切号前自动备份当前凭据，保留最近若干份。
 *
 * 锁说明：agy-switch 用 flock(account-switch.lock)。macOS 没有 flock(1)，Node 也没有
 * flock 绑定，桥用旁车锁 account-switch.node.lock（PID 存活检查 + 10 分钟过期）。
 * agy-switch 已弃用的前提下这只防桥自身并发；若将来要和它并存，装 util-linux 的
 * flock 并在此处改用同文件 flock。
 */
import { execFile } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { backup, keychainWrite, payloadFor, writeSessionFile, backupsDir } from "./credstore.mjs";
import { ensureFresh } from "./oauth.mjs";
import { patchAccount, readAccount, resolveAccount, toolsDir } from "./vault.mjs";
import { BridgeError, delay, log } from "./util.mjs";

const run = promisify(execFile);
const MAX_AUTO_BACKUPS = 8;

export async function acquireSwitchLock(dir = toolsDir()) {
  const sidecar = join(dir, "account-switch.node.lock");
  for (;;) {
    const existing = (() => {
      try {
        return JSON.parse(readFileSync(sidecar, "utf8"));
      } catch {
        return null;
      }
    })();
    if (existing?.pid) {
      let alive = true;
      try { process.kill(existing.pid, 0); } catch { alive = false; }
      const stale = !alive || Date.now() - (existing.ts ?? 0) > 10 * 60_000;
      if (!stale) throw new BridgeError("CAPACITY", `another account switch is in progress (pid ${existing.pid})`);
      log(`switch lock: clearing stale holder pid ${existing.pid}`);
      try { unlinkSync(sidecar); } catch { /* 竞态下由对方清理 */ }
    }
    try {
      const fd = openSync(sidecar, "wx");
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code === "EEXIST") { await delay(100); continue; }
      throw new BridgeError("SERVER", `cannot create switch lock: ${error.message}`);
    }
  }
  return () => { try { unlinkSync(sidecar); } catch { /* 已被清理 */ } };
}

/** 其它 agy 进程（交互会话、acp worker、headless 运行）在跑则不许切：热切换会让它们持有旧身份。hub 除外，由切换流程亲自实闭。 */
async function agyProcessSnapshot() {
  const { stdout } = await run("ps", ["-Ao", "pid=,command="]);
  const all = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bagy\b/.test(line) && !/agy-bridge|grep/.test(line))
    .map((line) => ({ pid: Number(line.split(/\s+/, 1)[0]), hub: line.includes("--hub"), command: line.split(/\s+/).slice(1, 4).join(" ") }));
  return { hubs: all.filter((p) => p.hub), others: all.filter((p) => !p.hub) };
}

/** hub 持有旧凭据内存副本：写入前关掉，下一次 agy 调用会用新凭据重建。 */
async function closeHubs() {
  const { hubs } = await agyProcessSnapshot();
  for (const hub of hubs) {
    try { process.kill(hub.pid, "SIGTERM"); } catch { /* 已退出 */ }
  }
  for (let i = 0; i < 20; i++) {
    const remaining = (await agyProcessSnapshot()).hubs;
    if (!remaining.length) return;
    await delay(250);
  }
  const left = (await agyProcessSnapshot()).hubs;
  if (left.length) throw new BridgeError("CAPACITY", `agy hub did not stop (pid ${left.map((p) => p.pid).join(", ")})`);
}

/**
 * 切到目标账号。写凭据前先刷新 token：刷新失败 = 账号已失效 = 零写入。
 * dryRun: 走完刷新与 payload 构造，不写任何东西。
 */
export async function switchTo(query, { dryRun = false, expectNoProcesses = true } = {}) {
  const target = resolveAccount(query);
  const release = dryRun ? null : await acquireSwitchLock();
  try {
    const account = readAccount(target.id);
    if (account.disabled) throw new BridgeError("BAD_REQUEST", `account ${target.email} is disabled`);

    const before = account.token.expiry_timestamp ?? 0;
    const token = await ensureFresh(account.token);
    const refreshed = token !== account.token;
    log(`switch ${target.email}: token ${refreshed ? `refreshed (expiry ${before} -> ${token.expiry_timestamp})` : "still fresh"}`);

    const payload = payloadFor(token);
    if (dryRun) {
      return { email: target.email, id: target.id, dryRun: true, refreshed, payloadBytes: payload.length };
    }

    if (expectNoProcesses) {
      const procs = (await agyProcessSnapshot()).others;
      if (procs.length) {
        throw new BridgeError("CAPACITY", `agy is still running (pid ${procs.map((p) => p.pid).join(", ")}); stop it before switching`);
      }
      await closeHubs();
    }

    const stamp = await backup(`auto-before-switch-to-${target.email}`);
    log(`switch ${target.email}: backup ${stamp} taken`);

    await keychainWrite(payload);
    writeSessionFile(payload);

    patchAccount(target.id, { token, last_used: Math.floor(Date.now() / 1000) });
    pruneAutoBackups();

    log(`switch ${target.email}: keychain + session file written`);
    return { email: target.email, id: target.id, backup: stamp, refreshed };
  } finally {
    release?.();
  }
}

function pruneAutoBackups() {
  const dir = backupsDir();
  const stamps = readdirSync(dir).filter((name) => name.includes("auto-before-switch")).sort();
  while (stamps.length > MAX_AUTO_BACKUPS) {
    const victim = stamps.shift();
    try {
      rmSync(join(dir, victim), { recursive: true, force: true });
      log(`pruned old auto backup ${victim}`);
    } catch { /* 清理失败无害 */ }
  }
}
