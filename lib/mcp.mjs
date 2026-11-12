/**
 * 回环 Streamable HTTP MCP 服务：把宿主（harness）的工具声明暴露给内层 agy，
 * 并把每次 tools/call 挂起，直到宿主执行完工具、在下一次请求里带回结果。
 * tools/call 用 SSE 回复，立刻发响应头，并定期发 keepalive / progress，避免 agy 侧 60 秒无响应头就放弃。
 */
import { createServer } from "node:http";
import { isRecord } from "./util.mjs";

const MCP_PROTOCOL_VERSION = "2025-06-18";

export class McpServer {
  #server;
  #port = 0;
  #open = new Set();

  /**
   * router: { authorize(tenant, token), listTools(tenant), callTool({ tenantKey, name, args, signal }) }
   * port: 固定端口时，重启后同一个 tenant URL 仍然可达，休眠会话才能带着工具 resume。
   */
  constructor(router, { keepAliveMs = 15_000, port = 0, log } = {}) {
    this.router = router;
    this.keepAliveMs = keepAliveMs;
    this.port = port;
    this.log = log ?? (() => {});
  }

  get url() {
    return `http://127.0.0.1:${this.#port}/mcp`;
  }

  /** 实际绑定的端口（固定端口被占用时会和配置值不同） */
  get boundPort() {
    return this.#port;
  }

  async start() {
    if (this.#server) return;
    const server = createServer((req, res) => { void this.#handle(req, res); });
    server.keepAliveTimeout = 0;
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    const listen = (port) => new Promise((resolve, reject) => {
      const onError = (error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    try {
      await listen(this.port);
    } catch (error) {
      // 固定端口被占用时退回随机端口：能启动比能 resume 更重要
      if (!this.port || error.code !== "EADDRINUSE") throw error;
      this.log(`MCP port ${this.port} is in use; falling back to an ephemeral port`);
      await listen(0);
    }
    this.#port = server.address().port;
    this.#server = server;
  }

  async close() {
    const server = this.#server;
    this.#server = undefined;
    for (const res of this.#open) res.destroy();
    this.#open.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "mcp" || segments.length !== 2) { res.writeHead(404).end(); return; }
    const tenantKey = segments[1];
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!this.router.authorize(tenantKey, token)) { res.writeHead(401).end(); return; }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST, DELETE" }).end(); return; }

    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      writeJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const messages = Array.isArray(body) ? body : [body];
    const requests = messages.filter((m) => isRecord(m) && typeof m.method === "string" && m.id !== undefined && m.id !== null);
    if (requests.length === 0) { res.writeHead(202).end(); return; }
    const call = requests.find((r) => r.method === "tools/call");
    if (call && requests.length === 1) {
      await this.#handleCall(res, call, tenantKey);
      return;
    }
    const replies = requests.map((r) => this.#answer(r, tenantKey));
    writeJson(res, 200, Array.isArray(body) ? replies : replies[0]);
  }

  #answer(request, tenantKey) {
    const reply = (result) => ({ jsonrpc: "2.0", id: request.id, result });
    switch (request.method) {
      case "initialize": {
        const version = typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : MCP_PROTOCOL_VERSION;
        return reply({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "host", version: "0.1.0" },
          instructions: "Tools of the calling harness. Every call is executed by the harness under its own permission policy.",
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: this.router.listTools(tenantKey) });
      case "resources/list": return reply({ resources: [] });
      case "resources/templates/list": return reply({ resourceTemplates: [] });
      case "prompts/list": return reply({ prompts: [] });
      case "tools/call": return { jsonrpc: "2.0", id: request.id, error: { code: -32600, message: "tools/call must be sent alone" } };
      default: return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    }
  }

  async #handleCall(res, request, tenantKey) {
    const params = isRecord(request.params) ? request.params : {};
    const meta = isRecord(params._meta) ? params._meta : {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    const progressToken = meta.progressToken;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    res.flushHeaders();
    this.#open.add(res);
    const controller = new AbortController();
    let settled = false;
    const onClose = () => {
      this.#open.delete(res);
      if (!settled) controller.abort(new Error("MCP client closed the tool call"));
    };
    res.on("close", onClose);
    let ticks = 0;
    const keepAlive = setInterval(() => {
      if (res.writableEnded) return;
      ticks += 1;
      res.write(": keepalive\n\n");
      if (typeof progressToken === "string" || typeof progressToken === "number") {
        writeEvent(res, { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ticks, message: "The harness is running the tool" } });
      }
    }, this.keepAliveMs);

    let result;
    try {
      result = await this.router.callTool({ tenantKey, name, args, signal: controller.signal });
    } catch (error) {
      result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    } finally {
      settled = true;
      clearInterval(keepAlive);
    }
    if (!res.writableEnded && !res.destroyed) {
      writeEvent(res, { jsonrpc: "2.0", id: request.id, result });
      res.end();
    }
    this.#open.delete(res);
    res.off("close", onClose);
  }
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function writeEvent(res, value) {
  res.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
}
