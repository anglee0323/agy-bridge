/**
 * 凭据存储：macOS 钥匙串条目（gemini/antigravity）+ agy 会话文件。
 * 实测结论（2026-11-06）：agy CLI 在 macOS 上从钥匙串认证；会话文件只是镜像。
 * 切号必须两处都写，与 agy-switch 的行为一致。
 * 任何日志与返回值都不携带凭据本体。
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BridgeError, log } from "./util.mjs";
import { writeAtomic } from "./vault.mjs";

const run = promisify(execFile);

const SERVICE = "gemini";
const ACCOUNT = "antigravity";
const PREFIX = "go-keyring-base64:";

export function sessionFilePath(env = process.env) {
  return env.AGY_SESSION_FILE ?? join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

export function backupsDir(env = process.env) {
  const dir = env.AGY_BRIDGE_BACKUP_DIR ?? join(homedir(), ".cache", "agy-bridge", "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 与 agy-switch cli_credentials.payload 完全一致的 JSON 形态。 */
export function payloadFor(token) {
  const date = new Date((token.expiry_timestamp ?? 0) * 1000);
  const iso = `${date.toISOString().slice(0, 19)}.${String(date.getUTCMilliseconds()).padStart(3, "0")}000Z`;
  const details = {
    token: {
      access_token: String(token.access_token ?? ""),
      token_type: "Bearer",
      refresh_token: String(token.refresh_token ?? ""),
      expiry: iso,
    },
    auth_method: "consumer",
  };
  if (token.id_token) details.id_token = token.id_token;
  return JSON.stringify(details);
}

export function parsePayload(payload) {
  const json = JSON.parse(payload);
  const token = json?.token ?? {};
  return {
    accessToken: token.access_token ?? null,
    refreshToken: token.refresh_token ?? null,
    expiry: token.expiry ?? null,
    idToken: json.id_token ?? null,
    authMethod: json.auth_method ?? null,
  };
}

// ---------- 钥匙串 ----------

function keychainValueRaw() {
  // -A 策略写入的条目可被本进程免提示读取
  return run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);
}

export async function keychainRead() {
  const raw = await keychainValueRaw();
  if (!raw) return null;
  const payload = raw.startsWith(PREFIX) ? Buffer.from(raw.slice(PREFIX.length), "base64").toString("utf8") : raw;
  try {
    return parsePayload(payload);
  } catch {
    return { unparseable: true };
  }
}

export async function keychainWrite(payload) {
  const value = PREFIX + Buffer.from(payload, "utf8").toString("base64");
  await run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]).catch(() => {});
  const { stderr } = await run("security", [
    "add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", value, "-A",
  ]).catch((error) => {
    throw new BridgeError("SERVER", `keychain write failed: ${String(error.stderr ?? error.message).trim().slice(0, 200)}`);
  }).then((r) => r ?? { stderr: "" });
  if (stderr?.trim()) log(`keychain add stderr (ignored): ${stderr.trim().slice(0, 120)}`);
}

// ---------- 会话文件（镜像） ----------

export function writeSessionFile(payload, env = process.env) {
  writeSessionFileAt(sessionFilePath(env), payload);
}

/** 写指定路径的会话文件（私有 HOME 也用这个）；拒绝符号链接与目录。 */
export function writeSessionFileAt(path, payload) {
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new BridgeError("SERVER", "agy session exists but is not a regular file; refusing to touch it");
  }
  writeAtomic(path, payload, 0o600);
}

export function readSessionFile(env = process.env) {
  const path = sessionFilePath(env);
  if (!existsSync(path)) return null;
  try {
    return parsePayload(readFileSync(path, "utf8"));
  } catch {
    return { unparseable: true };
  }
}

// ---------- 备份 / 恢复 ----------

/** 把当前钥匙串条目与会话文件快照到 backups/<时间戳>/，返回目录名。 */
export async function backup(note = "manual") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(backupsDir(), stamp);
  mkdirSync(dir, { recursive: true });
  const meta = { createdAt: new Date().toISOString(), note };

  const raw = await keychainValueRaw();
  if (raw) {
    writeFileSync(join(dir, "keychain.value"), raw, { mode: 0o600 });
    meta.keychain = "captured";
  } else {
    meta.keychain = "absent";
  }

  const sessionPath = sessionFilePath();
  if (existsSync(sessionPath)) {
    writeFileSync(join(dir, "session.payload"), readFileSync(sessionPath), { mode: 0o600 });
    meta.sessionFile = "captured";
  } else {
    meta.sessionFile = "absent";
  }

  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  return stamp;
}

/** 从指定备份恢复钥匙串与会话文件（原样字节写回）。 */
export async function restore(stamp) {
  const dir = join(backupsDir(), stamp);
  if (!existsSync(join(dir, "meta.json"))) throw new BridgeError("BAD_REQUEST", `no such backup: ${stamp}`);
  const restored = [];

  const keychainFile = join(dir, "keychain.value");
  if (existsSync(keychainFile)) {
    const raw = readFileSync(keychainFile, "utf8").trim();
    if (raw) {
      const payload = raw.startsWith(PREFIX) ? Buffer.from(raw.slice(PREFIX.length), "base64").toString("utf8") : raw;
      await keychainWrite(payload);
      restored.push("keychain");
    }
  }

  const sessionFile = join(dir, "session.payload");
  if (existsSync(sessionFile)) {
    writeSessionFile(readFileSync(sessionFile, "utf8"));
    restored.push("session-file");
  }
  return { restored };
}

export function listBackups() {
  const dir = backupsDir();
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "meta.json")))
    .sort()
    .reverse()
    .map((name) => {
      try {
        return { stamp: name, ...JSON.parse(readFileSync(join(dir, name, "meta.json"), "utf8")) };
      } catch {
        return { stamp: name, note: "unreadable" };
      }
    });
}
