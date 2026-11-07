/**
 * 读额度：官方 `agy -p /usage --output-format json`。不跑模型、不建会话（num_turns=0）。
 * 以私有 HOME 运行，所以不动全局钥匙串，也能读任意账号。
 *
 * /usage 的 JSON：command.data.groups[] = { name, buckets[] }，
 * bucket = { id, name, window: "5h"|"weekly", remaining_fraction, reset_time }。
 * 分组名 "Gemini Models" 对应 gemini，"Claude and GPT models" 对应 thirdparty。
 *
 * 注意：/usage 反映的是额度，不反映封禁——被封号的账号照样显示 100%。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { BridgeError } from "./util.mjs";

const run = promisify(execFile);

export function parseUsage(text, now = Date.now()) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let outer;
  try {
    outer = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const groups = outer?.command?.data?.groups;
  if (!Array.isArray(groups)) return null;
  const snapshot = { at: now };
  for (const group of groups) {
    const family = /gemini/i.test(group?.name ?? "") ? "gemini" : /claude|gpt/i.test(group?.name ?? "") ? "thirdparty" : null;
    if (!family || !Array.isArray(group.buckets)) continue;
    const entry = {};
    for (const bucket of group.buckets) {
      const key = bucket.window === "5h" ? "fiveHour" : bucket.window === "weekly" ? "weekly" : null;
      const resetAt = Date.parse(bucket.reset_time);
      if (!key || typeof bucket.remaining_fraction !== "number" || Number.isNaN(resetAt)) continue;
      entry[key] = { remaining: bucket.remaining_fraction, resetAt };
    }
    // 没有任何可解析窗口的族不记录，以免把“没数据”误读成“有数据”
    if (Object.keys(entry).length) snapshot[family] = entry;
  }
  return snapshot.gemini || snapshot.thirdparty ? snapshot : null;
}

async function hubPids() {
  const { stdout } = await run("ps", ["-Ao", "pid=,command="]);
  return new Set(
    stdout.split("\n").map((l) => l.trim()).filter((l) => l.includes("--hub") && /\bagy\b/.test(l)).map((l) => Number(l.split(/\s+/, 1)[0])),
  );
}

/**
 * 以 home 为 HOME 跑一次 /usage。agy -p 会顺带拉起一个常驻 hub 进程，
 * 读完把本次新增的 hub 收掉，避免在后台堆积。
 */
export async function readUsage({ agyBin, home, timeoutMs = 45_000 }) {
  const before = await hubPids().catch(() => new Set());
  try {
    const { code, stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(agyBin, ["-p", "/usage", "--output-format", "json"], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { err = (err + c).slice(-2000); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new BridgeError("TRANSPORT", `agy /usage timed out after ${timeoutMs}ms`)); }, timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (c) => { clearTimeout(timer); resolve({ code: c, stdout: out, stderr: err }); });
    });
    if (/Authentication required/i.test(stdout) || /Authentication required/i.test(stderr)) {
      throw new BridgeError("AUTH", "agy reports authentication required for this account");
    }
    const snapshot = parseUsage(stdout);
    if (!snapshot) throw new BridgeError("SERVER", `unexpected /usage output (exit ${code}): ${stdout.slice(0, 120).replace(/\s+/g, " ")}`);
    return snapshot;
  } finally {
    const after = await hubPids().catch(() => new Set());
    for (const pid of after) {
      if (!before.has(pid)) {
        try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ }
      }
    }
  }
}
