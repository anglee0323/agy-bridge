/**
 * OpenAI Responses 兼容层（Codex CLI 用的就是这一套）。
 *
 * Codex 从 2026-02 起只认 `wire_api = "responses"`，所以桥要接 Codex 必须说这个协议。
 * 这里做两件事，和 anthropic.mjs 同构：
 *   1. 把 Responses 请求（instructions + input items + tools）翻译成内部 OpenAI 形状；
 *   2. 把桥的输出翻译成 Responses 的 SSE 事件（message / reasoning / function_call /
 *      custom_tool_call 四种 output item）。
 *
 * 只做协议翻译，不改任何上游行为：不碰上下文上限、不伪装客户端、不改提示词。
 * Codex 的 `apply_patch` 是 freeform 的 `type: "custom"` 工具，模型侧按单字符串参数
 * 呈现，回来时还原成 `custom_tool_call`，否则 Codex 会报 “incompatible payload”。
 */
import { randomBytes } from "node:crypto";
import { mapError } from "./util.mjs";

/**
 * Codex 给 freeform 工具的描述里写着 “不要包成 JSON”，但那是对 Responses 原生
 * custom tool 说的；桥把它呈现成 JSON function，模型照原话输出原文就会被 agy 判成
 * 非法参数。这里只改这一句协议约定，不改工具语义。
 */
export function customToolDescription(description) {
  const text = String(description ?? "")
    .replace(/[^.!?\n]*(?:freeform|do not wrap|don't wrap|not wrap)[^.!?\n]*[.!?]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const contract = 'This tool is freeform: put the raw text in the "input" field of the JSON arguments object.';
  return text ? `${text} ${contract}` : contract;
}

const CUSTOM_TOOL_SCHEMA = {
  type: "object",
  properties: { input: { type: "string", description: "Raw freeform input for this tool. Do not wrap it in JSON." } },
  required: ["input"],
};

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function contentParts(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const parts = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
    } else if (part?.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return parts;
}

function outputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  if (output === null || output === undefined) return "";
  return JSON.stringify(output);
}

/** 把 Codex 的 freeform 输入还原成字符串：模型可能给 {"input": "..."}，也可能直接给原文 */
export function customInput(argumentsJson) {
  try {
    const value = JSON.parse(argumentsJson || "");
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      if (typeof value.input === "string") return value.input;
      const strings = Object.values(value).filter((v) => typeof v === "string");
      if (strings.length === 1) return strings[0];
    }
  } catch {
    // 不是 JSON：模型直接把 freeform 文本当参数给了
  }
  return argumentsJson ?? "";
}

/**
 * Responses 请求 → 内部请求。
 * 连续的 function_call / custom_tool_call 合并进同一条 assistant 消息，和桥在
 * 工具挂起时写下的指纹（`a:id1,id2`）对齐，否则每轮都会被判成“历史被改写”。
 */
export function toChatBody(body, { fallbackModel } = {}) {
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions) messages.push({ role: "system", content: body.instructions });

  const pushCall = (call) => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.tool_calls) && !last.content) last.tool_calls.push(call);
    else messages.push({ role: "assistant", content: "", tool_calls: [call] });
  };

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else {
    for (const item of Array.isArray(body.input) ? body.input : []) {
      switch (item?.type) {
        case "message": {
          const parts = contentParts(item.content);
          const role = item.role === "developer" ? "system" : item.role;
          if (role === "assistant") messages.push({ role: "assistant", content: textOf(item.content) });
          else messages.push({ role: role === "system" ? "system" : "user", content: parts });
          break;
        }
        case "function_call":
          pushCall({ id: String(item.call_id ?? ""), type: "function", function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "{}") } });
          break;
        case "custom_tool_call":
          pushCall({ id: String(item.call_id ?? ""), type: "function", function: { name: String(item.name ?? ""), arguments: JSON.stringify({ input: String(item.input ?? "") }) } });
          break;
        case "function_call_output":
        case "custom_tool_call_output":
          messages.push({ role: "tool", tool_call_id: String(item.call_id ?? ""), content: outputText(item.output) });
          break;
        default:
          // reasoning / item_reference / 内置工具结果：桥不消费，跳过
          break;
      }
    }
  }

  const customTools = new Set();
  const tools = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (tool?.type === "function" && typeof tool.name === "string") {
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: String(tool.description ?? ""),
          parameters: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} },
        },
      });
    } else if (tool?.type === "custom" && typeof tool.name === "string") {
      customTools.add(tool.name);
      tools.push({
        type: "function",
        function: { name: tool.name, description: customToolDescription(tool.description), parameters: CUSTOM_TOOL_SCHEMA },
      });
    }
    // local_shell / web_search / file_search 等内置工具：桥不实现，直接跳过
  }

  const model = typeof body.model === "string" && body.model ? body.model : fallbackModel;
  const effort = body.reasoning?.effort;
  return {
    model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(typeof effort === "string" ? { reasoning_effort: effort } : {}),
    stream: body.stream === true,
    customTools,
  };
}

/** 桥的用量 → Responses usage */
export function toResponsesUsage(usage) {
  const input = usage?.prompt ?? 0;
  const output = usage?.completion ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage?.cacheRead ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage?.reasoning ?? 0 },
    total_tokens: input + output,
  };
}

const ERROR_TYPES = {
  BAD_REQUEST: "invalid_request_error",
  UNKNOWN_MODEL: "invalid_request_error",
  AUTH: "authentication_error",
  QUOTA: "insufficient_quota",
  RATE_LIMIT: "rate_limit_error",
  CAPACITY: "rate_limit_error",
  CONTEXT: "invalid_request_error",
  TIMEOUT: "timeout",
  TRANSPORT: "server_error",
  SERVER: "server_error",
  EMPTY: "server_error",
};

function errorBody(error) {
  const e = mapError(error);
  return { error: { message: e.message, type: ERROR_TYPES[e.kind] ?? "server_error", code: e.code ?? null, param: null } };
}

const itemId = (prefix) => `${prefix}_${randomBytes(10).toString("hex")}`;

/**
 * 一次 /v1/responses 响应的写出器。与 output.mjs / anthropic.mjs 同接口。
 */
export class ResponsesOutput {
  constructor(res, { stream, model, customTools = new Set() }) {
    this.res = res;
    this.stream = stream;
    this.model = model;
    this.customTools = customTools;
    this.id = itemId("resp");
    this.createdAt = Math.floor(Date.now() / 1000);
    this.committed = false;
    this.ended = false;
    this.hasText = false;
    this.degraded = false;
    this.output = [];
    this.current = undefined;
    this.text = "";
    this.thinking = "";
  }

  #event(type, payload) {
    this.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  }

  #response(status, usage) {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output: this.output,
      usage: usage ? toResponsesUsage(usage) : null,
      error: null,
      incomplete_details: null,
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
    };
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
      this.#event("response.created", { response: this.#response("in_progress") });
    } else {
      this.res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...(this.degraded ? { "x-agy-degraded": "1" } : {}) });
    }
  }

  #closeItem() {
    const current = this.current;
    if (!current) return;
    this.current = undefined;
    let final = current.item;
    if (current.kind === "message") final = { ...current.item, status: "completed", content: [{ type: "output_text", text: this.text, annotations: [] }] };
    else if (current.kind === "reasoning") final = { ...current.item, summary: [{ type: "summary_text", text: this.thinking }] };
    this.output[current.index] = final;
    if (!this.stream) return;
    if (current.kind === "message") {
      this.#event("response.output_text.done", { item_id: current.item.id, output_index: current.index, content_index: 0, text: this.text });
      this.#event("response.content_part.done", { item_id: current.item.id, output_index: current.index, content_index: 0, part: { type: "output_text", text: this.text, annotations: [] } });
    } else if (current.kind === "reasoning") {
      this.#event("response.reasoning_summary_text.done", { item_id: current.item.id, output_index: current.index, summary_index: 0, text: this.thinking });
      this.#event("response.reasoning_summary_part.done", { item_id: current.item.id, output_index: current.index, summary_index: 0, part: { type: "summary_text", text: this.thinking } });
    }
    this.#event("response.output_item.done", { output_index: current.index, item: final });
  }

  #openItem(kind, item) {
    this.#closeItem();
    const index = this.output.length;
    this.output.push(item);
    this.current = { kind, index, item };
    if (this.stream) {
      this.#event("response.output_item.added", { output_index: index, item });
      if (kind === "message") this.#event("response.content_part.added", { item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      if (kind === "reasoning") this.#event("response.reasoning_summary_part.added", { item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } });
    }
    return index;
  }

  emitText(text) {
    if (!text || this.ended) return;
    if (text.trim()) this.hasText = true;
    this.#commit();
    if (this.current?.kind !== "message") {
      this.text = "";
      this.#openItem("message", { id: itemId("msg"), type: "message", status: "in_progress", role: "assistant", content: [] });
    }
    this.text += text;
    if (this.stream) this.#event("response.output_text.delta", { item_id: this.current.item.id, output_index: this.current.index, content_index: 0, delta: text });
  }

  emitReasoning(text) {
    if (!text || this.ended) return;
    this.#commit();
    if (this.current?.kind !== "reasoning") {
      this.thinking = "";
      this.#openItem("reasoning", { id: itemId("rs"), type: "reasoning", summary: [] });
    }
    this.thinking += text;
    if (this.stream) this.#event("response.reasoning_summary_text.delta", { item_id: this.current.item.id, output_index: this.current.index, summary_index: 0, delta: text });
  }

  emitToolCall(_index, call) {
    if (this.ended) return;
    this.#commit();
    const custom = this.customTools.has(call.name);
    if (custom) {
      const input = customInput(call.argumentsJson);
      const item = { id: itemId("ctc"), type: "custom_tool_call", status: "completed", call_id: call.id, name: call.name, input };
      const index = this.#openItem("tool", item);
      if (this.stream) {
        this.#event("response.custom_tool_call_input.delta", { item_id: item.id, output_index: index, delta: input });
        this.#event("response.custom_tool_call_input.done", { item_id: item.id, output_index: index, input });
      }
      this.#closeItem();
      return;
    }
    const item = { id: itemId("fc"), type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: call.argumentsJson || "{}" };
    const index = this.#openItem("tool", item);
    if (this.stream) {
      this.#event("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: item.arguments });
      this.#event("response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: item.arguments });
    }
    this.#closeItem();
  }

  keepalive() {
    if (this.ended) return;
    this.#commit();
    if (this.stream) this.res.write(": keepalive\n\n");
    else this.res.write(" ");
  }

  finish(reason, usage) {
    if (this.ended) return;
    this.#commit();
    this.#closeItem();
    if (this.stream) {
      this.#event("response.completed", { response: this.#response("completed", usage) });
      this.res.end();
    } else {
      this.res.end(JSON.stringify(this.#response("completed", usage)));
    }
    this.ended = true;
  }

  fail(error) {
    if (this.ended) return;
    const body = errorBody(error);
    if (!this.committed) {
      const e = mapError(error);
      const text = JSON.stringify(body);
      this.res.writeHead(e.status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
      this.res.end(text);
    } else if (this.stream) {
      this.#event("response.failed", { response: { ...this.#response("failed"), error: body.error } });
      this.res.end();
    } else {
      this.res.end(JSON.stringify(body));
    }
    this.ended = true;
  }
}
