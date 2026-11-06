/**
 * 账号金库：直接读写 agy-switch 的数据目录（~/.antigravity_tools）。
 * 保持字段原样往返，不做结构升级；agy-switch 若再打开也看到的同一份真相。
 * 绝不打印任何 token 值。
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError, isRecord, log } from "./util.mjs";

export function toolsDir(env = process.env) {
  const custom = env.AGY_TOOLS_DIR;
  if (custom && custom.trim()) return custom;
  return join(homedir(), ".antigravity_tools");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 原子写：同目录临时文件 + rename。 */
export function writeAtomic(path, content, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

function loadIndex(dir) {
  const path = join(dir, "accounts.json");
  if (!existsSync(path)) throw new BridgeError("BAD_REQUEST", `account vault not found at ${dir}`);
  return readJson(path);
}

export function listAccounts(dir = toolsDir()) {
  const index = loadIndex(dir);
  return index.accounts.map((s) => ({
    id: s.id,
    email: s.email,
    name: s.name ?? null,
    label: s.label ?? null,
    disabled: s.disabled === true,
    isCurrent: s.id === index.current_account_id,
    lastUsed: s.last_used ?? 0,
  }));
}

export function readAccount(accountId, dir = toolsDir()) {
  const path = join(dir, "accounts", `${accountId}.json`);
  if (!existsSync(path)) throw new BridgeError("BAD_REQUEST", `account file not found: ${accountId}`);
  return readJson(path);
}

/** 只更新给定字段，保留其它内容（quota、device_profile 等不被旧快照覆盖）。 */
export function patchAccount(accountId, patch, dir = toolsDir()) {
  const path = join(dir, "accounts", `${accountId}.json`);
  const latest = readJson(path);
  const next = { ...latest, ...patch };
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** 谁是当前登录的号：钥匙串里的 refresh_token 与金库比对（不打印任何值）。 */
export function findCurrentAccount(keychainRefreshToken, dir = toolsDir()) {
  const index = loadIndex(dir);
  for (const s of index.accounts) {
    try {
      const account = readAccount(s.id, dir);
      if (isRecord(account.token) && account.token.refresh_token === keychainRefreshToken) {
        return { id: s.id, email: s.email };
      }
    } catch (error) {
      log(`vault: skip unreadable account ${s.id.slice(0, 8)}: ${error.message}`);
    }
  }
  return null;
}

/** 按邮箱前缀或 ID 找账号，供 CLI 免复制 UUID。 */
export function resolveAccount(query, dir = toolsDir()) {
  const accounts = listAccounts(dir);
  const lower = query.toLowerCase();
  const hit = accounts.find((a) => a.id === query)
    ?? accounts.find((a) => a.email.toLowerCase() === lower)
    ?? accounts.find((a) => (a.name ?? "").toLowerCase() === lower || (a.label ?? "").toLowerCase() === lower)
    ?? accounts.find((a) => a.email.toLowerCase().startsWith(lower))
    ?? null;
  if (!hit) {
    throw new BridgeError("BAD_REQUEST", `no account matches "${query}" (have: ${accounts.map((a) => a.email).join(", ")})`);
  }
  return hit;
}

/** 把一个账号收进金库（主号入库 / 新登录入库共用）。同邮箱已存在则只刷新它的 token。 */
export function upsertAccount({ email, name = null, accessToken, refreshToken, idToken = null, expiryTimestamp, projectId = null }, dir = toolsDir()) {
  const accountsDir = join(dir, "accounts");
  if (!existsSync(accountsDir)) throw new BridgeError("BAD_REQUEST", `account vault not found at ${dir}`);
  const index = loadIndex(dir);
  const existing = index.accounts.find((s) => s.email === email);
  const now = Math.floor(Date.now() / 1000);
  const tokenData = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Math.max(0, expiryTimestamp - now),
    expiry_timestamp: expiryTimestamp,
    token_type: "Bearer",
    email,
    project_id: projectId,
    oauth_client_key: "antigravity_enterprise",
    is_gcp_tos: false,
    ...(idToken ? { id_token: idToken } : {}),
  };
  if (existing) {
    patchAccount(existing.id, { token: tokenData, disabled: false, disabled_reason: undefined }, dir);
    return { id: existing.id, email, updated: true };
  }
  const id = randomUUID();
  const account = {
    id,
    email,
    name: name ?? email.split("@")[0],
    token: tokenData,
    device_profile: null,
    quota: null,
    disabled: false,
    validation_blocked: false,
    created_at: now,
    last_used: now,
  };
  writeAtomic(join(accountsDir, `${id}.json`), `${JSON.stringify(account, null, 2)}\n`);
  index.accounts.push({ id, email, name: account.name, disabled: false, protected_models: [], created_at: now, last_used: now });
  writeAtomic(join(dir, "accounts.json"), `${JSON.stringify(index, null, 2)}\n`);
  return { id, email, updated: false };
}
