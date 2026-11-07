/**
 * Antigravity 的 OAuth 客户端凭据（client id / secret）。
 *
 * 这是 Google 随每个 `agy` 一起分发的公共客户端凭据，不属于任何用户，但也不放进本仓库：
 * 运行时从你本机已安装的 agy 二进制里取，并按二进制的大小与修改时间缓存。
 *
 * 来源优先级：环境变量 AGY_OAUTH_CLIENT_ID + AGY_OAUTH_CLIENT_SECRET > 缓存 > 扫描 agy 二进制。
 *
 * 二进制里有多组候选（互不相邻，顺序不可依赖，且 Google 对它们都认），所以不能靠探测选 client：
 * client id 取自 agy 自己登录得到的 id_token 的 aud 字段（离线、精确）；
 * secret 再用一个假的 refresh token 向令牌端点探测：与该 id 配对的返回 invalid_grant，错的返回 invalid_client。
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findAgy } from "./agy.mjs";
import { keychainRead, readSessionFile } from "./credstore.mjs";
import { listAccounts, readAccount } from "./vault.mjs";
import { BridgeError, log } from "./util.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{28}/g;
const ID_RE = /\d{9,16}-[a-z0-9]{32}\.apps\.googleusercontent\.com/g;

export function cachePath(env = process.env) {
  return env.AGY_BRIDGE_OAUTH_CACHE ?? join(homedir(), ".cache", "agy-bridge", "oauth-client.json");
}

/** 从二进制里按固定格式收集候选，按出现顺序去重。分块读取，二进制约 200MB，不整体载入内存。 */
export function scanCandidates(path) {
  const CH = 16 * 1024 * 1024;
  const OVERLAP = 256;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(CH + OVERLAP);
    const secrets = [];
    const ids = [];
    for (let off = 0; off < size; off += CH) {
      const n = readSync(fd, buf, 0, CH + OVERLAP, off);
      const text = buf.toString("latin1", 0, n);
      // 只收起点落在本块内的匹配；跨块的在下一块的重叠区里完整出现，避免重复
      for (const m of text.matchAll(SECRET_RE)) if (m.index < CH && !secrets.includes(m[0])) secrets.push(m[0]);
      for (const m of text.matchAll(ID_RE)) if (m.index < CH && !ids.includes(m[0])) ids.push(m[0]);
    }
    return { ids, secrets };
  } finally {
    closeSync(fd);
  }
}

/** 从 JWT（id_token）里取 aud：Google 签发该令牌的 OAuth client id。不校验签名，只用于识别。 */
export function audienceOf(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString("utf8"));
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    return typeof aud === "string" && aud.endsWith(".apps.googleusercontent.com") ? aud : null;
  } catch {
    return null;
  }
}

/** 依次在 agy 会话文件、钥匙串、金库账号里找 id_token，返回签发它的 client id。 */
async function clientIdHint() {
  const sources = [
    () => readSessionFile()?.idToken,
    async () => (await keychainRead())?.idToken,
    () => {
      for (const a of listAccounts()) {
        const t = readAccount(a.id).token?.id_token;
        if (t) return t;
      }
      return null;
    },
  ];
  for (const get of sources) {
    try {
      const aud = audienceOf(await get());
      if (aud) return aud;
    } catch { /* 该来源不可用，试下一个 */ }
  }
  return null;
}

/** 解读探测响应：match 这一对有效；mismatch 这一对无效；unknown 无法判断。 */
export function classifyProbe(status, body) {
  let error = "";
  try { error = String(JSON.parse(body).error ?? ""); } catch { /* 非 JSON */ }
  if (error === "invalid_grant") return "match";
  if (error === "invalid_client" || error === "unauthorized_client") return "mismatch";
  if (status >= 500 || status === 429) return "unknown";
  return "unknown";
}

async function probe({ clientId, clientSecret }) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: "agy-bridge-probe", grant_type: "refresh_token" }),
  });
  return classifyProbe(res.status, await res.text());
}

function binaryStamp(path) {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    return { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } finally {
    closeSync(fd);
  }
}

let memo;

/** 返回 { clientId, clientSecret }。 */
export async function oauthClient(env = process.env) {
  if (env.AGY_OAUTH_CLIENT_ID && env.AGY_OAUTH_CLIENT_SECRET) {
    return { clientId: env.AGY_OAUTH_CLIENT_ID, clientSecret: env.AGY_OAUTH_CLIENT_SECRET };
  }
  if (memo) return memo;

  const agyPath = realpathSync(findAgy(env));
  const stamp = binaryStamp(agyPath);
  const cacheFile = cachePath(env);
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs && cached.clientId && cached.clientSecret) {
      memo = { clientId: cached.clientId, clientSecret: cached.clientSecret };
      return memo;
    }
  } catch { /* 无缓存或已失效，重新扫描 */ }

  const candidates = scanCandidates(agyPath);
  if (!candidates.secrets.length) {
    throw new BridgeError("SERVER", "could not locate the OAuth client in your agy binary; set AGY_OAUTH_CLIENT_ID and AGY_OAUTH_CLIENT_SECRET");
  }
  // 登录令牌的 aud 是权威的 client id；没有登录过时，只有二进制里恰好一个候选才敢用
  const hint = await clientIdHint();
  const clientId = hint ?? (candidates.ids.length === 1 ? candidates.ids[0] : null);
  if (!clientId) {
    throw new BridgeError("SERVER", "cannot tell which OAuth client agy uses (sign in with `agy` once first, or set AGY_OAUTH_CLIENT_ID and AGY_OAUTH_CLIENT_SECRET)");
  }

  let clientSecret = candidates.secrets.length === 1 ? candidates.secrets[0] : null;
  for (const candidate of clientSecret ? [] : candidates.secrets) {
    let verdict;
    try {
      verdict = await probe({ clientId, clientSecret: candidate });
    } catch (error) {
      throw new BridgeError("TRANSPORT", `cannot reach Google to identify the OAuth client: ${error.message}`);
    }
    if (verdict === "match") { clientSecret = candidate; break; }
    if (verdict === "unknown") throw new BridgeError("TRANSPORT", "unexpected response from Google while identifying the OAuth client; try again later");
  }
  if (!clientSecret) throw new BridgeError("SERVER", "none of the secrets found in agy matched the OAuth client; set AGY_OAUTH_CLIENT_ID and AGY_OAUTH_CLIENT_SECRET");
  const chosen = { clientId, clientSecret };

  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, `${JSON.stringify({ ...stamp, ...chosen }, null, 2)}\n`, { mode: 0o600 });
  log(`oauth client identified from agy binary and login token (cached; ${candidates.secrets.length} secret candidate(s))`);
  memo = chosen;
  return memo;
}
