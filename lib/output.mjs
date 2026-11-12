/**
 * 一次 /v1/chat/completions 响应的写出器（流式 SSE 或一次性 JSON）。
 * 响应头延迟到第一段内容或第一次保活时才发：此前出错还能返回真实 HTTP 状态码，
 * harness 才能按 401/429/5xx 正常重试。
 */
import { randomBytes } from "node:crypto";
import { mapError } from "./util.mjs";

export function toOpenAIUsage(u) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.prompt,
    completion_tokens: u.completion,
    total_tokens: u.prompt + u.completion,
    prompt_tokens_details: { cached_tokens: u.cacheRead, ...(u.cacheWrite ? { cache_write_tokens: u.cacheWrite } : {}) },
    ...(u.reasoning ? { completion_tokens_details: { reasoning_tokens: u.reasoning } } : {}),
  };
}

export class Output {
  constructor(res, { stream, model, includeUsage }) {
    this.res = res;
    this.stream = stream;
    this.model = model;
    this.includeUsage = includeUsage;
    this.id = `chatcmpl-${randomBytes(12).toString("hex")}`;
    this.created = Math.floor(Date.now() / 1000);
    this.committed = false;
    this.ended = false;
    this.degraded = false;
    this.sentRole = false;
    this.hasText = false;
    this.content = "";
    this.reasoning = "";
    this.toolCalls = [];
  }

  #commit() {
    if (this.committed) return;
    this.committed = true;
    const degraded = this.degraded ? { "x-agy-degraded": "1" } : {};
    if (this.stream) {
      this.res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...degraded,
      });
      this.res.flushHeaders?.();
    } else {
      this.res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...degraded });
    }
  }

  #write(obj) {
    this.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  #chunk(delta, finishReason = null) {
    const d = this.sentRole ? delta : { role: "assistant", ...delta };
    this.sentRole = true;
    this.#write({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta: d, finish_reason: finishReason }] });
  }

  emitText(text) {
    if (!text || this.ended) return;
    if (text.trim()) this.hasText = true;
    if (this.stream) { this.#commit(); this.#chunk({ content: text }); } else this.content += text;
  }

  emitReasoning(text) {
    if (!text || this.ended) return;
    if (this.stream) { this.#commit(); this.#chunk({ reasoning_content: text }); } else this.reasoning += text;
  }

  emitToolCall(index, call) {
    if (this.ended) return;
    const entry = { id: call.id, type: "function", function: { name: call.name, arguments: call.argumentsJson } };
    this.toolCalls.push(entry);
    if (this.stream) { this.#commit(); this.#chunk({ tool_calls: [{ index, ...entry }] }); }
  }

  keepalive() {
    if (this.ended) return;
    this.#commit();
    this.res.write(this.stream ? ": keepalive\n\n" : " ");
  }

  finish(reason, usage) {
    if (this.ended) return;
    this.#commit();
    const u = toOpenAIUsage(usage);
    if (this.stream) {
      this.#chunk({}, reason);
      if (this.includeUsage && u) this.#write({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: u });
      this.res.write("data: [DONE]\n\n");
      this.res.end();
    } else {
      const message = { role: "assistant", content: this.content || null };
      if (this.reasoning) message.reasoning_content = this.reasoning;
      if (this.toolCalls.length) message.tool_calls = this.toolCalls;
      this.res.end(JSON.stringify({
        id: this.id,
        object: "chat.completion",
        created: this.created,
        model: this.model,
        choices: [{ index: 0, message, finish_reason: reason }],
        ...(u ? { usage: u } : {}),
      }));
    }
    this.ended = true;
  }

  fail(error) {
    if (this.ended) return;
    const e = mapError(error);
    const payload = { error: { message: e.message, type: e.kind.toLowerCase(), code: e.code } };
    if (!this.committed) {
      const body = JSON.stringify(payload);
      this.res.writeHead(e.status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      this.res.end(body);
    } else if (this.stream) {
      // OpenAI SDK 遇到带 error 字段的 data 帧会抛 APIError
      this.#write(payload);
      this.res.write("data: [DONE]\n\n");
      this.res.end();
    } else {
      this.res.end(JSON.stringify(payload));
    }
    this.ended = true;
  }
}
