/**
 * 从 agy 本地会话库读逐步用量：`<gemini-dir>/agy/conversations/<sessionId>.db` 的 `steps` 表，
 * `step_type = 15`、`status = 3` 的行，`metadata` 字段 9 是 Protobuf `ModelUsageStats`。
 * session/prompt 只在整轮结束时给总量；工具调用中途的每一步只能从这里拿。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

let DatabaseSync;
function database() {
  if (DatabaseSync !== undefined) return DatabaseSync;
  try {
    DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync ?? null;
  } catch {
    DatabaseSync = null;
  }
  return DatabaseSync;
}

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    const byte = buf[offset + i];
    if (byte === undefined) return undefined;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
    shift += 7n;
  }
  return undefined;
}

function count(raw) {
  const signed = BigInt.asIntN(64, raw);
  if (signed <= 0n) return 0;
  return signed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(signed);
}

/** 逐字段扫描一段 Protobuf；onField(field, wire, value|bytes) 返回 false 表示格式异常。 */
function scan(buf, onField) {
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) return false;
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field <= 0) return false;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) return false;
      pos = v.next;
      onField(field, 0, v.value);
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return false;
      pos += 8;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) return false;
      const n = Number(len.value);
      if (!Number.isSafeInteger(n) || len.next + n > buf.length) return false;
      onField(field, 2, buf.subarray(len.next, len.next + n));
      pos = len.next + n;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return false;
      pos += 4;
    } else {
      return false;
    }
  }
  return true;
}

export function decodeModelUsage(metadata) {
  let stats;
  const ok = scan(metadata, (field, wire, value) => {
    if (field !== 9 || wire !== 2) return;
    const s = { inputTokens: 0, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 };
    const subOk = scan(value, (f, w, v) => {
      if (w !== 0) return;
      if (f === 2) s.inputTokens = count(v);
      else if (f === 3) s.outputTokens = count(v);
      else if (f === 4) s.cachedWriteTokens = count(v);
      else if (f === 5) s.cachedReadTokens = count(v);
      else if (f === 9) s.thoughtTokens = count(v);
    });
    if (subOk) stats = s;
  });
  return ok ? stats : undefined;
}

function open(dbPath) {
  const Db = database();
  if (!Db || !existsSync(dbPath)) return undefined;
  try {
    return new Db(dbPath, { readOnly: true, timeout: 100 });
  } catch {
    return undefined;
  }
}

export function peekMaxStepIdx(dbPath) {
  const db = open(dbPath);
  if (!db) return -1;
  try {
    const raw = db.prepare("SELECT COALESCE(MAX(idx), -1) AS m FROM steps WHERE step_type = 15 AND status = 3").get()?.m;
    return typeof raw === "bigint" ? Number(raw) : typeof raw === "number" ? raw : -1;
  } catch {
    return -1;
  } finally {
    db.close();
  }
}

/**
 * 读取 afterIdx 之后的已完成模型步。
 * 返回 last（最后一次模型调用，代表当前真实上下文占用）与 sum（整段输出累计）。
 */
export function readStepsAfter(dbPath, afterIdx) {
  const db = open(dbPath);
  if (!db) return undefined;
  try {
    const rows = db.prepare("SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 AND idx > ? ORDER BY idx ASC").all(afterIdx);
    let maxIdx = afterIdx;
    let last;
    let calls = 0;
    const sum = { outputTokens: 0, thoughtTokens: 0 };
    for (const row of rows) {
      const idx = typeof row.idx === "bigint" ? Number(row.idx) : row.idx;
      const bytes = row.metadata instanceof Uint8Array ? row.metadata : undefined;
      if (typeof idx !== "number" || !bytes) continue;
      const decoded = decodeModelUsage(bytes);
      if (!decoded) continue;
      maxIdx = Math.max(maxIdx, idx);
      calls += 1;
      last = decoded;
      sum.outputTokens += decoded.outputTokens;
      sum.thoughtTokens += decoded.thoughtTokens;
    }
    return calls > 0 ? { maxIdx, calls, last, sum } : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
