#!/usr/bin/env node
/**
 * agy-bridge：把本机已登录的 Antigravity CLI（agy acp）包成 OpenAI 兼容接口（默认 127.0.0.1:8789/v1），
 * 工具由调用方 harness 经 MCP 挂起回填自己执行。凭据本体只存在于官方 agy、钥匙串与备份目录。
 *
 * 子命令：
 *   serve                            启动服务（默认，可省略）
 *   accounts / whoami                 查看金库账号与当前登录号
 *   backup [note]                    备份当前钥匙串条目 + 会话文件
 *   backups / restore <stamp>        查看 / 恢复备份
 *   switch <id|email> [--dry-run]    切号：先刷新目标 token，失败零写入
 *
 * 环境变量：AGY_BRIDGE_PORT / AGY_BRIDGE_TOKEN / AGY_BRIDGE_HOME / AGY_TOOLS_DIR / AGY_SESSION_FILE 等
 */
import { BridgeError, mapError } from "../lib/util.mjs";
import { listAccounts, findCurrentAccount, resolveAccount, upsertAccount, migrateFromAgySwitch, removeAccount } from "../lib/vault.mjs";
import { backup, restore, listBackups, keychainRead } from "../lib/credstore.mjs";
import { switchTo } from "../lib/switcher.mjs";
import { refreshToken } from "../lib/oauth.mjs";
import { addAccount } from "../lib/login.mjs";
import { loadState, mutateState } from "../lib/state.mjs";
import { refreshQuota } from "../lib/homes.mjs";
import { accountBlock } from "../lib/pool.mjs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homesRoot } from "../lib/homes.mjs";

const [subcommand = "serve", ...rest] = process.argv.slice(2);

/** 用 id_token（本地解 JWT）或 userinfo 接口辨识当前账号，不打日志。 */
async function identifyToken(current) {
  if (current.idToken) {
    try {
      const payload = JSON.parse(Buffer.from(current.idToken.split(".")[1], "base64url").toString("utf8"));
      if (payload.email) return { email: payload.email, projectId: null };
    } catch { /* 落到 userinfo */ }
  }
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { authorization: `Bearer ${current.accessToken}` } });
  if (!res.ok) throw new BridgeError("AUTH", `cannot identify current account (userinfo ${res.status})`);
  const info = await res.json();
  return { email: info.email, projectId: null };
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function runCli() {
  if (subcommand === "protect" || subcommand === "unprotect") {
    const query = rest.find((arg) => !arg.startsWith("--"));
    if (!query) throw new BridgeError("BAD_REQUEST", `usage: agy-bridge ${subcommand} <id|email|name>`);
    const account = resolveAccount(query);
    mutateState((state) => {
      const set = new Set(state.protected ?? []);
      if (subcommand === "protect") set.add(account.id); else set.delete(account.id);
      state.protected = [...set];
    });
    return print({ account: account.email, protected: subcommand === "protect" });
  }
  if (subcommand === "accounts") {
    const current = await keychainRead();
    const match = current?.refreshToken ? findCurrentAccount(current.refreshToken) : null;
    const state = loadState();
    const now = Date.now();
    return print(listAccounts().map((a) => {
      const row = { ...a, isKeychain: match ? a.id === match.id : false, protected: (state.protected ?? []).includes(a.id) };
      for (const family of ["gemini", "thirdparty"]) {
        const b = accountBlock(a.id, family, state, now);
        if (b.blocked) (row.blocked ??= {})[family] = { reason: b.reason, minutes: Math.max(1, Math.round((b.until - now) / 60_000)) };
      }
      if (state.banStrikes?.[a.id]) row.banStrikes = state.banStrikes[a.id];
      return row;
    }));
  }
  if (subcommand === "quota") {
    const cachedOnly = rest.includes("--cached");
    const includeAll = rest.includes("--all");
    const accounts = listAccounts().filter((a) => !a.disabled);
    const fmtPct = (w) => (w ? `${String(Math.round(w.remaining * 100)).padStart(3)}%` : "  --");
    const fmtTime = (w) => (w ? new Date(w.resetAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "");
    const lines = [];
    for (const a of accounts) {
      const state = loadState();
      const cooling = state.cooldowns?.[a.id];
      const skip = !cachedOnly && !includeAll && cooling && cooling.until > Date.now() && (cooling.reason === "banned" || cooling.reason === "auth");
      let note = "";
      if (!cachedOnly && !skip) {
        try { await refreshQuota(a.id); } catch (error) { note = `读取失败: ${error.message.slice(0, 60)}`; }
      }
      const q = loadState().quota?.[a.id];
      if (skip) note = `跳过(${cooling.reason}，--all 强制读取)`;
      const cell = (family) => q?.[family] ? `5h ${fmtPct(q[family].fiveHour)}(${fmtTime(q[family].fiveHour)}) 周 ${fmtPct(q[family].weekly)}(${fmtTime(q[family].weekly)})` : "无数据";
      lines.push(`${(a.name ?? a.email).padEnd(18)} Gemini: ${cell("gemini")}\n${" ".repeat(18)} Claude/GPT: ${cell("thirdparty")}${note ? `\n${" ".repeat(18)} ${note}` : ""}`);
    }
    console.log(lines.join("\n"));
    return;
  }
  if (subcommand === "reset-cooldowns") {
    const query = rest.find((arg) => !arg.startsWith("--"));
    const target = query ? resolveAccount(query) : null;
    const cleared = mutateState((state) => {
      const ids = target ? [target.id] : Object.keys({ ...state.cooldowns, ...state.familyCooldowns, ...state.banStrikes });
      for (const id of ids) { delete state.cooldowns[id]; delete state.familyCooldowns[id]; delete state.banStrikes[id]; }
      return ids.length;
    });
    return print({ cleared, scope: target ? target.email : "all" });
  }
  if (subcommand === "backup") {
    const note = rest.find((arg) => !arg.startsWith("--")) ?? "manual";
    return print({ backup: await backup(note) });
  }
  if (subcommand === "backups") return print(listBackups());
  if (subcommand === "restore") {
    const stamp = rest[0];
    if (!stamp) throw new BridgeError("BAD_REQUEST", "usage: agy-bridge restore <stamp>");
    return print(await restore(stamp));
  }
  if (subcommand === "switch") {
    const query = rest.find((arg) => !arg.startsWith("--"));
    if (!query) throw new BridgeError("BAD_REQUEST", "usage: agy-bridge switch <id|email> [--dry-run]");
    return print(await switchTo(query, { dryRun: rest.includes("--dry-run") }));
  }
  if (subcommand === "import-current") {
    const current = await keychainRead();
    if (!current?.refreshToken) throw new BridgeError("BAD_REQUEST", "keychain has no antigravity credential to import");
    const identity = await identifyToken(current);
    const expiryTimestamp = current.expiry ? Math.floor(Date.parse(current.expiry) / 1000) : 0;
    return print(upsertAccount({ email: identity.email, name: rest.find((a) => !a.startsWith("--")) ?? null, accessToken: current.accessToken, refreshToken: current.refreshToken, idToken: current.idToken, expiryTimestamp }));
  }
  if (subcommand === "add-account") {
    const result = await addAccount({ open: !rest.includes("--no-browser") }, (msg) => console.error(msg));
    return print(result);
  }
  if (subcommand === "remove") {
    const query = rest.find((arg) => !arg.startsWith("--"));
    if (!query) throw new BridgeError("BAD_REQUEST", "usage: agy-bridge remove <id|email|name>");
    const account = resolveAccount(query);
    mutateState((state) => {
      state.protected = (state.protected ?? []).filter((id) => id !== account.id);
      if (state.currentAccountId === account.id) state.currentAccountId = null;
      delete state.cooldowns[account.id]; delete state.familyCooldowns[account.id]; delete state.banStrikes[account.id]; delete state.quota[account.id];
    });
    rmSync(join(homesRoot(), account.id), { recursive: true, force: true });
    return print({ ...removeAccount(account.id), email: account.email });
  }
  if (subcommand === "migrate-from-agy-switch") {
    return print(migrateFromAgySwitch());
  }
  if (subcommand === "whoami") {
    const current = await keychainRead();
    if (!current?.refreshToken) return print({ signedIn: false });
    const identity = await identifyToken(current);
    const match = findCurrentAccount(current.refreshToken);
    return print({ signedIn: true, email: identity.email, inVault: !!match, vaultId: match?.id ?? null });
  }
  if (subcommand !== "serve") throw new BridgeError("BAD_REQUEST", `unknown subcommand: ${subcommand}`);
  return false;
}

const cli = await runCli();
if (cli !== false) process.exit(0);
await import("./serve.mjs");
