/**
 * 一个常驻的 `agy acp` 前台进程（--process-per-session：每个会话一个 worker）。
 * 负责 NDJSON JSON-RPC 链路、按会话分发通知，拒绝我们没有声明的客户端能力（fs / terminal）。
 */
import { spawn } from "node:child_process";

export class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "error"}`);
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class AcpProcess {
  #child;
  #buffer = "";
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();
  #stderr = "";
  #exitError;

  constructor({ argv, cwd, clientName, clientVersion, onExit, log }) {
    this.argv = argv;
    this.cwd = cwd;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.onExit = onExit;
    this.log = log ?? (() => {});
  }

  get alive() {
    return this.#child !== undefined && this.#exitError === undefined;
  }

  get pid() {
    return this.#child?.pid;
  }

  async start(timeoutMs) {
    // detached + 进程组：stop 时 kill(-pid) 能把 --process-per-session 拉起的 worker 一起收掉
    const child = spawn(this.argv[0], this.argv.slice(1), { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env, detached: true });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr.on("data", (chunk) => { this.#stderr = (this.#stderr + chunk).slice(-8192); });
    child.stdin.on("error", () => {});
    child.on("exit", (code, signal) => {
      const tail = this.#stderr.trim().split("\n").slice(-3).join(" | ");
      this.#fail(new Error(`agy acp exited (code=${code ?? "null"} signal=${signal ?? "null"})${tail ? `: ${tail}` : ""}`));
    });
    child.on("error", (error) => this.#fail(error));
    this.initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    }, timeoutMs);
  }

  stop() {
    this.#fail(new Error("ACP process stopped"));
    const child = this.#child;
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* 已退出 */ } }
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } }, 3000).unref();
    }
  }

  request(method, params, timeoutMs) {
    if (!this.alive) return Promise.reject(new Error(`ACP link unavailable${this.#exitError ? `: ${this.#exitError.message}` : ""}`));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      let timer;
      if (timeoutMs) timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    if (this.alive) this.#send({ jsonrpc: "2.0", method, params });
  }

  async newSession(params, listener, timeoutMs) {
    const result = await this.request("session/new", params, timeoutMs);
    this.#listeners.set(result.sessionId, listener);
    return result;
  }

  /**
   * 接回一个已关闭的会话（agy 1.5.x 支持 session/resume）。带 mcpServers 时由 agy 决定
   * 是否重新建立工具通道；调用方仍需保证那个 MCP 端点真的可达。
   */
  async resumeSession(sessionId, listener, { mcpServers, timeoutMs = 120_000 } = {}) {
    const result = await this.request("session/resume", { sessionId, ...(mcpServers ? { mcpServers } : {}) }, timeoutMs);
    this.#listeners.set(result?.sessionId ?? sessionId, listener);
    return result;
  }

  async setConfigOption(sessionId, configId, value) {
    const result = await this.request("session/set_config_option", { sessionId, configId, value }, 60_000);
    return result?.configOptions ?? [];
  }

  prompt(sessionId, prompt) {
    return this.request("session/prompt", { sessionId, prompt });
  }

  cancel(sessionId) {
    this.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId) {
    this.#listeners.delete(sessionId);
    if (!this.alive) return;
    try {
      await this.request("session/close", { sessionId }, 15_000);
    } catch {
      // 关不掉的会话随进程退出一起释放
    }
  }

  #send(message) {
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error) {
    if (this.#exitError !== undefined) return;
    this.#exitError = error;
    for (const { reject, timer } of this.#pending.values()) {
      if (timer) clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
    this.onExit?.(this, error);
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`acp: dropped non-JSON frame (${line.length} bytes)`);
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.method === undefined && message.id !== undefined) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) entry.reject(new RpcError(entry.method, message.error));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      const { sessionId, update } = message.params ?? {};
      if (sessionId && update) this.#listeners.get(sessionId)?.onUpdate(update);
      return;
    }
    if (message.id === undefined) return;
    if (message.method === "session/request_permission") {
      const request = message.params ?? {};
      let outcome;
      try {
        outcome = this.#listeners.get(request.sessionId)?.onPermission?.(request);
      } catch {
        outcome = undefined;
      }
      this.#send({ jsonrpc: "2.0", id: message.id, result: { outcome: outcome ?? { outcome: "cancelled" } } });
      return;
    }
    // 文件系统、终端、elicitation 能力都没有声明，一律拒绝
    this.log(`acp: refused agent request ${message.method}`);
    this.#send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `${message.method} is not supported by this client` } });
  }
}
