/**
 * 添加账号：浏览器 Google OAuth 授权 → code 换 token → 存入金库。
 * 移植 agy-switch oauth_server/oauth 的参数与流程；只写金库，不动当前登录态。
 */
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { BridgeError } from "./util.mjs";
import { CLIENT_ID, CLIENT_SECRET, USER_AGENT } from "./oauth.mjs";
import { upsertAccount } from "./vault.mjs";

const run = promisify(execFile);
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

function statePath() {
  return join(homedir(), ".cache", "agy-bridge", "state.json");
}

export function loadState() {
  try {
    const state = JSON.parse(readFileSync(statePath(), "utf8"));
    return { currentAccountId: null, exhaustedUntil: {}, protected: [], ...state };
  } catch {
    return { currentAccountId: null, exhaustedUntil: {}, protected: [] };
  }
}

export function saveState(state) {
  const path = statePath();
  writeFileSync(path, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

export { statePath };

/** 启动双栈回环回调监听，返回 {port, waitForCode, close}。 */
function callbackServer(expectedState, timeoutMs = 5 * 60_000) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/oauth-callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (error || !code || state !== expectedState) {
      res.end("<html><body><h3>授权未完成</h3><p>请回到终端重试。</p></body></html>");
      server.emit("code", { ok: false, error: error ?? "callback missing code or state mismatch" });
      return;
    }
    res.end("<html><body><h3>授权成功</h3><p>可以关闭此页面，回到终端继续。</p></body></html>");
    server.emit("code", { ok: true, code });
  });
  // 无 host 监听 = 双栈（::1 + 127.0.0.1），与 agy-switch 的双栈兼容策略一致
  return new Promise((resolvePromise, rejectPromise) => {
    server.listen(0, () => resolvePromise({
      port: server.address().port,
      close: () => server.close(),
      waitForCode: () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new BridgeError("SERVER", `OAuth callback timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        server.once("code", (result) => { clearTimeout(timer); result.ok ? resolve(result.code) : reject(new BridgeError("AUTH", `authorization failed: ${result.error}`)); });
      }),
    }));
    server.once("error", rejectPromise);
  });
}

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new BridgeError("AUTH", `token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function identify(accessToken) {
  const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new BridgeError("AUTH", `cannot identify account (userinfo ${res.status})`);
  const info = await res.json();
  return { email: info.email, name: info.name ?? null };
}

/**
 * 完整添加账号流程。返回 {email, id}。
 * open=false 时不拉浏览器（测试用），只打印 URL。
 */
export async function addAccount({ open = true }, log = console.error) {
  const state = randomBytes(16).toString("hex");
  const server = await callbackServer(state);
  const redirectUri = `http://localhost:${server.port}/oauth-callback`;
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);

  log(`authorization URL:\n${url.toString()}`);
  if (open) {
    await run("open", [url.toString()]).catch(() => log("cannot open browser; open the URL manually"));
  }

  try {
    const code = await server.waitForCode();
    const tokens = await exchangeCode(code, redirectUri);
    if (!tokens.refresh_token) {
      throw new BridgeError("AUTH", "Google did not return a refresh_token. Revoke the app's access at https://myaccount.google.com/permissions and retry.");
    }
    const { email, name } = await identify(tokens.access_token);
    const now = Math.floor(Date.now() / 1000);
    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in ?? 0,
      expiry_timestamp: now + (tokens.expires_in ?? 0),
      token_type: "Bearer",
      email,
      project_id: null,
      oauth_client_key: "antigravity_enterprise",
      is_gcp_tos: false,
      ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
    };
    const result = upsertAccount({ email, name, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token ?? null, expiryTimestamp: tokenData.expiry_timestamp });
    return { email, ...result };
  } finally {
    server.close();
  }
}

export function fileExists(path) {
  return existsSync(path);
}
