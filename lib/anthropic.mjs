/**
 * Anthropic Messages 兼容层。
 *
 * 社区里的 Magpie provider 插件、Claude Code、Amp 都只说 Anthropic Messages；桥内部
 * 只有一套 OpenAI 形状的归一化逻辑，所以这里只做两件事：
 *   1. 把 Anthropic 请求翻译成内部（OpenAI 形状）请求，复用同一套会话匹配与工具回填；
 *   2. 把桥的输出翻译回 Anthropic 的 SSE 事件（thinking / text / tool_use 三种内容块）。
 * 请求翻译不改变语义：tool_use ↔ tool_calls、tool_result ↔ role:tool、image ↔ image_url。
 */
import { randomBytes } from "node:crypto";
import { mapError } from "./util.mjs";

/** count_tokens 只是给客户端估算上下文用，按字符数粗算即可，不消耗额度 */
const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1_600;

function blocksOf(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((b) => b && typeof b === "object") : [];
}

function systemText(system) {
  if (typeof system === "string") return system;
  return blocksOf(system).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n\n");
}

function imagePart(block) {
  const source = block.source ?? {};
  if (source.type === "base64" && source.data) {
    return { type: "image_url", image_url: { url: `data:${source.media_type ?? "image/png"};base64,${source.data}` } };
  }
  if (source.type === "url" && source.url) return { type: "image_url", image_url: { url: source.url } };
  return undefined;
}

function toolResultParts(block) {
  const content = block.content;
  if (typeof content === "string") return content;
  const parts = [];
  for (const item of blocksOf(content)) {
    if (item.type === "text") parts.push({ type: "text", text: item.text ?? "" });
    else if (item.type === "image") {
      const part = imagePart(item);
      if (part) parts.push(part);
    }
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

/**
 * Anthropic 请求 → 内部请求。system 放最前面；同一 user 消息里的 tool_result 拆成
 * 独立的 role:tool 消息（必须排在紧随其后的文本/图片之前，指纹才对得上）。
 */
export function toChatBody(body, { fallbackModel } = {}) {
  const messages = [];
  const system = systemText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const blocks = blocksOf(message.content);
    if (message.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
        id: String(b.id ?? ""),
        type: "function",
        function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) },
      }));
      messages.push({ role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    for (const block of blocks.filter((b) => b.type === "tool_result")) {
      messages.push({ role: "tool", tool_call_id: String(block.tool_use_id ?? ""), content: toolResultParts(block) });
    }
    const rest = [];
    for (const block of blocks) {
      if (block.type === "text") rest.push({ type: "text", text: block.text ?? "" });
      else if (block.type === "image") {
        const part = imagePart(block);
        if (part) rest.push(part);
      }
    }
    if (rest.length) messages.push({ role: "user", content: rest });
  }

  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t) => t && typeof t.name === "string")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: String(t.description ?? ""),
        parameters: t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} },
      },
    }));

  // 客户端自己的模型名（claude-sonnet-4-5 之类）桥不认识：交给调用方给的默认模型
  const model = typeof body.model === "string" && body.model ? body.model : fallbackModel;
  const thinking = body.thinking?.type;
  return {
    model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(thinking === "enabled" ? { reasoning_effort: "high" } : thinking === "disabled" ? { reasoning_effort: "low" } : {}),
    stream: body.stream === true,
  };
}

/** 粗略 token 估算：文本按 4 字符 1 token，图片按固定值 */
export function estimateTokens(body) {
  let chars = systemText(body.system).length;
  let images = 0;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const block of blocksOf(message.content)) {
      if (block.type === "text") chars += String(block.text ?? "").length;
      else if (block.type === "image") images += 1;
      else if (block.type === "tool_use") chars += JSON.stringify(block.input ?? {}).length;
      else if (block.type === "tool_result") {
        const content = block.content;
        chars += typeof content === "string" ? content.length : blocksOf(content).map((b) => (b.type === "text" ? String(b.text ?? "").length : 0)).reduce((a, b) => a + b, 0);
        images += blocksOf(content).filter((b) => b.type === "image").length;
      }
    }
  }
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    chars += JSON.stringify(tool).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

/** 桥的 OpenAI 停止原因 → Anthropic stop_reason */
function stopReason(reason) {
  switch (reason) {
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    case "content_filter": return "refusal";
    default: return "end_turn";
  }
}

/** 桥的用量 → Anthropic usage（input_tokens 不含缓存读写） */
export function toAnthropicUsage(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return {
    input_tokens: Math.max(0, (usage.prompt ?? 0) - cacheRead - cacheWrite),
    output_tokens: usage.completion ?? 0,
    ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
  };
}

const ERROR_TYPES = {
  BAD_REQUEST: ["invalid_request_error", 400],
  UNKNOWN_MODEL: ["not_found_error", 404],
  AUTH: ["authentication_error", 401],
  QUOTA: ["rate_limit_error", 429],
  RATE_LIMIT: ["rate_limit_error", 429],
  CAPACITY: ["rate_limit_error", 429],
  CONTEXT: ["invalid_request_error", 400],
  TIMEOUT: ["api_error", 504],
  TRANSPORT: ["api_error", 502],
  SERVER: ["api_error", 502],
  EMPTY: ["api_error", 502],
};

function errorPayload(error) {
  const e = mapError(error);
  const [type, status] = ERROR_TYPES[e.kind] ?? ["api_error", 502];
  return { status, body: { type: "error", error: { type, message: e.message } } };
}

/**
 * 一次 /v1/messages 响应的写出器。与 output.mjs 的 Output 同接口
 * （emitText / emitReasoning / emitToolCall / keepalive / finish / fail），
 * 由 Runtime 决定用哪一个。
 */
export class AnthropicOutput {
  constructor(res, { stream, model }) {
    this.res = res;
    this.stream = stream;
    this.model = model;
    this.id = `msg_${randomBytes(12).toString("hex")}`;
    this.committed = false;
    this.ended = false;
    this.hasText = false;
    this.degraded = false;
    this.blocks = [];
    this.open = undefined;
    this.nextIndex = 0;
    this.text = "";
    this.thinking = "";
    this.toolUses = [];
  }

  #write(event, data) {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #commit() {
    if (this.committed) return;
    this.committed = true;
    if (this.stream) {
      this.res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...(this.degraded ? { "x-agy-degraded": "1" } : {}),
      });
      this.res.flushHeaders?.();
      this.#write("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    } else {
      this.res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...(this.degraded ? { "x-agy-degraded": "1" } : {}) });
    }
  }

  #closeBlock() {
    if (this.open === undefined) return;
    if (this.stream) this.#write("content_block_stop", { type: "content_block_stop", index: this.open });
    this.open = undefined;
  }

  #openBlock(type, block) {
    this.#closeBlock();
    const index = this.nextIndex++;
    this.open = index;
    this.blocks.push({ type, index, block });
    if (this.stream) this.#write("content_block_start", { type: "content_block_start", index, content_block: block });
    return index;
  }

  emitText(text) {
    if (!text || this.ended) return;
    if (text.trim()) this.hasText = true;
    this.#commit();
    if (this.open === undefined || this.blocks[this.open]?.type !== "text") {
      this.#openBlock("text", { type: "text", text: "" });
    }
    this.text += text;
    if (this.stream) this.#write("content_block_delta", { type: "content_block_delta", index: this.open, delta: { type: "text_delta", text } });
  }

  emitReasoning(text) {
    if (!text || this.ended) return;
    this.#commit();
    if (this.open === undefined || this.blocks[this.open]?.type !== "thinking") {
      this.#openBlock("thinking", { type: "thinking", thinking: "" });
    }
    this.thinking += text;
    if (this.stream) this.#write("content_block_delta", { type: "content_block_delta", index: this.open, delta: { type: "thinking_delta", thinking: text } });
  }

  emitToolCall(_index, call) {
    if (this.ended) return;
    this.#commit();
    // 桥一次给出完整参数，Anthropic 侧用一段 input_json_delta 表达即可
    const block = { type: "tool_use", id: call.id, name: call.name, input: {} };
    const index = this.#openBlock("tool_use", block);
    this.toolUses.push({ id: call.id, name: call.name, argumentsJson: call.argumentsJson });
    if (this.stream) {
      this.#write("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: call.argumentsJson || "{}" } });
      this.#closeBlock();
    }
  }

  keepalive() {
    if (this.ended) return;
    this.#commit();
    if (this.stream) this.#write("ping", { type: "ping" });
    else this.res.write(" ");
  }

  finish(reason, usage) {
    if (this.ended) return;
    this.#commit();
    const stop = stopReason(reason);
    const u = toAnthropicUsage(usage);
    if (this.stream) {
      this.#closeBlock();
      this.#write("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: u });
      this.#write("message_stop", { type: "message_stop" });
      this.res.end();
    } else {
      const content = [];
      if (this.thinking) content.push({ type: "thinking", thinking: this.thinking, signature: "" });
      if (this.text) content.push({ type: "text", text: this.text });
      for (const call of this.toolUses) content.push({ type: "tool_use", id: call.id, name: call.name, input: safeJson(call.argumentsJson) });
      this.res.end(JSON.stringify({
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: u,
      }));
    }
    this.ended = true;
  }

  fail(error) {
    if (this.ended) return;
    const { status, body } = errorPayload(error);
    if (!this.committed) {
      const text = JSON.stringify(body);
      this.res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
      this.res.end(text);
    } else if (this.stream) {
      this.#write("error", body);
      this.res.end();
    } else {
      this.res.end(JSON.stringify(body));
    }
    this.ended = true;
  }
}

function safeJson(text) {
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
