#!/usr/bin/env node
/**
 * agy-bridge：把本机已登录的 Antigravity CLI（agy acp）包成 OpenAI 兼容接口（默认 127.0.0.1:8789/v1），
 * 工具由调用方 harness 经 MCP 挂起回填自己执行。凭据本体只存在于官方 agy、钥匙串与备份目录。
 *
 * 子命令：
 *   serve                            启动服务（默认，可省略）
 *   accounts                         列出金库账号（~/.antigravity_tools）并标记当前登录号
 *   backup [note]                    备份当前钥匙串条目 + 会话文件
 *   backups / restore <stamp>        查看 / 恢复备份
 *   switch <id|email> [--dry-run]    切号：先刷新目标 token，失败零写入
 *
 * 环境变量：AGY_BRIDGE_PORT / AGY_BRIDGE_TOKEN / AGY_BRIDGE_HOME / AGY_TOOLS_DIR / AGY_SESSION_FILE 等
 */
import { BridgeError, mapError } from "../lib/util.mjs";
import { listAccounts, findCurrentAccount, resolveAccount, upsertAccount, migrateFromAgySwitch } from "../lib/vault.mjs";
import { backup, restore, listBackups, keychainRead } from "../lib/credstore.mjs";
import { switchTo } from "../lib/switcher.mjs";
import { refreshToken } from "../lib/oauth.mjs";
import { addAccount, loadState, saveState } from "../lib/login.mjs";

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
    const state = loadState();
    const account = resolveAccount(query);
    const set = new Set(state.protected ?? []);
    if (subcommand === "protect") set.add(account.id); else set.delete(account.id);
    state.protected = [...set];
    saveState(state);
    return print({ account: account.email, protected: subcommand === "protect" });
  }
  if (subcommand === "accounts") {
    const current = await keychainRead();
    const match = current?.refreshToken ? findCurrentAccount(current.refreshToken) : null;
    const state = loadState();
    const now = Date.now();
    return print(listAccounts().map((a) => ({
      ...a,
      isKeychain: match ? a.id === match.id : false,
      protected: (state.protected ?? []).includes(a.id),
      coolingMinutes: (state.exhaustedUntil?.[a.id] ?? 0) > now ? Math.round((state.exhaustedUntil[a.id] - now) / 60_000) : 0,
    })));
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
