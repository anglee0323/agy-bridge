/**
 * Google OAuth 刷新，移植自 agy-switch oauth.rs：
 * 同一 client 上 invalid_grant 先做一次 500ms 退避重试再定论。
 * 刷新成功但未返回新 refresh_token 时沿用旧的（Google 的惯例行为）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BridgeError, delay } from "./util.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLIENT_KEY = "antigravity_enterprise";
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-REDACTED";
const REFRESH_SKEW_SECONDS = 900;

function version() {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

const USER_AGENT = `vscode/1.X.X (Antigravity/${version()})`;

async function refreshOnce(refreshToken) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body,
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: text };
  try {
    const data = JSON.parse(text);
    if (!data.access_token) return { ok: false, status: res.status, error: "response missing access_token" };
    return { ok: true, data };
  } catch {
    return { ok: false, status: res.status, error: `unparseable token response: ${text.slice(0, 120)}` };
  }
}

/** 刷新 access_token；失败原样抛出可读错误（不携带任何密钥）。 */
export async function refreshToken(refreshToken) {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await delay(500);
    const result = await refreshOnce(refreshToken);
    if (result.ok) return result.data;
    lastError = result.error;
    const isGrantError = result.error.includes("invalid_grant");
    if (!isGrantError || attempt > 0) break;
  }
  throw new BridgeError("AUTH", `token refresh failed [${CLIENT_KEY}]: ${lastError.slice(0, 300)}`);
}

/**
 * 对应 ensure_fresh_token：还有 15 分钟以上有效期就直接用，否则刷新。
 * 返回更新后的 tokenData（同对象字段：access_token / expires_in / expiry_timestamp / id_token）。
 */
export function ensureFresh(tokenData, now = Math.floor(Date.now() / 1000)) {
  if (!tokenData?.refresh_token) throw new BridgeError("AUTH", "account has no refresh_token");
  if ((tokenData.expiry_timestamp ?? 0) > now + REFRESH_SKEW_SECONDS) {
    return Promise.resolve(tokenData);
  }
  return refreshToken(tokenData.refresh_token).then((data) => ({
    ...tokenData,
    access_token: data.access_token,
    expires_in: data.expires_in,
    expiry_timestamp: now + (data.expires_in ?? 0),
    id_token: data.id_token ?? tokenData.id_token ?? null,
  }));
}
