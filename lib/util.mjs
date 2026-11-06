import { createHash } from "node:crypto";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const sha1 = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);

export const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function log(...parts) {
  process.stderr.write(`[${new Date().toISOString()}] ${parts.join(" ")}\n`);
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/** 单消费者事件队列：wait() 在有数据时返回 true，超时或中止时返回 false。 */
export class AsyncQueue {
  #items = [];
  #waiters = new Set();

  push(item) {
    this.#items.push(item);
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  peek() { return this.#items[0]; }
  shift() { return this.#items.shift(); }
  get size() { return this.#items.length; }

  wait(signal, timeoutMs) {
    if (this.#items.length > 0) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer;
      const done = (value) => {
        if (timer !== undefined) clearTimeout(timer);
        this.#waiters.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const wake = () => done(true);
      const onAbort = () => done(false);
      this.#waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => done(this.#items.length > 0), timeoutMs);
    });
  }
}

const STATUS = {
  BAD_REQUEST: 400,
  UNKNOWN_MODEL: 404,
  AUTH: 401,
  QUOTA: 429,
  RATE_LIMIT: 429,
  CAPACITY: 429,
  CONTEXT: 400,
  TIMEOUT: 504,
  TRANSPORT: 502,
  SERVER: 502,
  EMPTY: 502,
};

const CODE = {
  BAD_REQUEST: "invalid_request_error",
  UNKNOWN_MODEL: "model_not_found",
  AUTH: "unauthenticated",
  QUOTA: "insufficient_quota",
  RATE_LIMIT: "rate_limit_exceeded",
  CAPACITY: "rate_limit_exceeded",
  CONTEXT: "context_length_exceeded",
  TIMEOUT: "timeout",
  TRANSPORT: "upstream_unavailable",
  SERVER: "upstream_error",
  EMPTY: "empty_response",
};

export class BridgeError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
    this.status = STATUS[kind] ?? 502;
    this.code = CODE[kind] ?? "upstream_error";
  }
}

/** 把 agy / 传输层错误映射成稳定类别，文案让各家 harness 的重试与压缩逻辑能识别。 */
export function mapError(error) {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication required|not logged in|unauthenticated|sign in/i.test(message)) {
    return new BridgeError("AUTH", `Antigravity requires sign-in: run \`agy\` once in a terminal (${message})`);
  }
  if (/quota|resource.?exhausted|limit reached|exceeded your/i.test(message)) {
    return new BridgeError("QUOTA", `Antigravity quota exhausted: ${message}`);
  }
  if (/rate.?limit|429|too many requests|overloaded|capacity/i.test(message)) {
    return new BridgeError("RATE_LIMIT", `Antigravity rate limit: ${message}`);
  }
  if (/context|too long|token limit|maximum.*tokens/i.test(message)) {
    return new BridgeError("CONTEXT", `Your input exceeds the context window of this model (Antigravity: ${message})`);
  }
  if (/timeout|timed out|deadline/i.test(message)) return new BridgeError("TIMEOUT", `Antigravity timed out: ${message}`);
  return new BridgeError("TRANSPORT", `Antigravity: ${message}`);
}
