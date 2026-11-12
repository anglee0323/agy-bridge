/**
 * 休眠会话账本（~/.cache/agy-bridge/sessions.json，0600）。
 *
 * 桥重启、会话被淘汰、或空闲超时都会关掉 ACP 会话；只存会话 id 与指纹，不存消息原文。
 * 下一次请求如果能对上（系统提示、工具声明、历史前缀都一致），就用 ACP 的
 * `session/resume` 接回原会话，而不是重放整段历史——重放会丢掉上游的 prompt cache。
 *
 * 带工具的会话还要能接回桥自己的 MCP 端点，所以记录里保存 tenantKey/tenantSecret 与
 * 当时的 MCP 端口；端口对不上（桥换了地址）就不复用，退回重建。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_AGE_MS = 24 * 3600_000;
const MAX_ENTRIES = 32;

export function sessionsPath(env = process.env) {
  return env.AGY_BRIDGE_SESSIONS ?? join(homedir(), ".cache", "agy-bridge", "sessions.json");
}

export function loadSessions(env = process.env) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(sessionsPath(env), "utf8"));
  } catch {
    return {};
  }
  const sessions = raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {};
  const now = Date.now();
  const kept = {};
  for (const [key, record] of Object.entries(sessions)) {
    if (!record || typeof record.sessionId !== "string" || !Array.isArray(record.fps)) continue;
    if (now - (record.updatedAt ?? 0) > MAX_AGE_MS) continue;
    kept[key] = record;
  }
  return kept;
}

export function saveSessions(sessions, env = process.env) {
  const entries = Object.entries(sessions)
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
    .slice(0, MAX_ENTRIES);
  const path = sessionsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.sessions.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function rememberSession(sessions, key, record, env = process.env) {
  sessions[key] = { ...record, updatedAt: Date.now() };
  saveSessions(sessions, env);
  return sessions[key];
}

export function forgetSession(sessions, key, env = process.env) {
  if (!sessions[key]) return;
  delete sessions[key];
  saveSessions(sessions, env);
}
