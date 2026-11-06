#!/usr/bin/env node
/**
 * agy-bridge：把本机任何 ACP agent 包成 OpenAI 兼容接口（默认 127.0.0.1:8789/v1），
 * 工具由调用方 harness 经 MCP 挂起回填自己执行。桥不保存、不代理任何凭据。
 *
 * 环境变量：
 *   AGY_BRIDGE_PORT / AGY_BRIDGE_TOKEN / AGY_BRIDGE_HOME / AGY_BRIDGE_DEFAULT_EFFORT ...
 */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Output } from "../lib/output.mjs";
import { Runtime } from "../lib/runtime.mjs";
import { BridgeError, log, mapError } from "../lib/util.mjs";

const env = process.env;
const PORT = Number(env.AGY_BRIDGE_PORT ?? 8789);
const HOST = "127.0.0.1";
const TOKEN = env.AGY_BRIDGE_TOKEN || undefined;

function findAgy() {
  if (env.AGY_BIN) return env.AGY_BIN;
  const candidates = [join(homedir(), ".local", "bin", "agy"), ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "agy"))];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("agy not found; install the Antigravity CLI and sign in once with `agy`");
  return found;
}

const runtime = new Runtime({
  agyBin: findAgy(),
  home: env.AGY_BRIDGE_HOME ?? join(homedir(), ".cache", "agy-bridge", "agents", "antigravity"),
  defaultEffort: env.AGY_BRIDGE_DEFAULT_EFFORT ?? "high",
  maxLiveSessions: Number(env.AGY_BRIDGE_MAX_SESSIONS ?? 4),
  idleTtlMs: Number(env.AGY_BRIDGE_IDLE_TTL_MS ?? 15 * 60_000),
  parkedTtlMs: Number(env.AGY_BRIDGE_PARKED_TTL_MS ?? 10 * 60_000),
  parkSettleMs: 250,
  relayAfterMs: Number(env.AGY_BRIDGE_RELAY_AFTER_MS ?? 85_000),
  maxRelays: 6,
  maxContinuations: 3,
  keepAliveMs: 10_000,
  autoSwitch: env.AGY_BRIDGE_AUTO_SWITCH !== "0",
});

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function reject(res, error) {
  const e = mapError(error);
  json(res, e.status, { error: { message: e.message, type: e.kind.toLowerCase(), code: e.code } });
}

async function readJson(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BridgeError("BAD_REQUEST", "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("BAD_REQUEST", "request body is not valid JSON");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  // DNS rebinding：Host 必须是回环地址；浏览器跨站请求一律带 Origin，直接拒绝
  if (!ALLOWED_HOSTS.has(String(req.headers.host ?? ""))) return json(res, 403, { error: { message: "forbidden host" } });
  if (req.headers.origin) return json(res, 403, { error: { message: "browser requests are not accepted" } });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: { message: "invalid bridge token", code: "invalid_api_key" } });

  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, runtime.health());

    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!runtime.listModels().length) await runtime.warmup().catch(() => {});
      return json(res, 200, {
        object: "list",
        data: runtime.listModels().map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "antigravity", name: m.name })),
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
        throw new BridgeError("BAD_REQUEST", "content-type must be application/json");
      }
      const body = await readJson(req);
      const out = new Output(res, { stream: body.stream === true, model: String(body.model ?? ""), includeUsage: body.stream_options?.include_usage === true });
      const controller = new AbortController();
      res.on("close", () => { if (!out.ended) controller.abort(); });
      try {
        await runtime.chat(body, out, controller.signal);
      } catch (error) {
        const e = mapError(error);
        log(`chat failed: ${e.kind} ${e.message}`);
        out.fail(e);
      }
      if (!out.ended && !res.writableEnded) res.end();
      return;
    }

    json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (error) {
    if (!res.headersSent) reject(res, error);
    else res.end();
  }
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.listen(PORT, HOST, () => {
  log(`agy-bridge listening on http://${HOST}:${PORT}/v1`);
  runtime.warmup().then(
    () => log(`models: ${runtime.listModels().map((m) => m.id).join(", ")}`),
    (error) => log(`warmup failed: ${mapError(error).message}`),
  );
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  server.close();
  await runtime.dispose();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
