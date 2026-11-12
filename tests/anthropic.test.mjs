import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicOutput, estimateTokens, toAnthropicUsage, toChatBody } from "../lib/anthropic.mjs";
import { BridgeError } from "../lib/util.mjs";

function fakeRes() {
  const chunks = [];
  return {
    status: 0,
    headers: {},
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    flushHeaders() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk) chunks.push(String(chunk)); this.ended = true; },
    body() { return chunks.join(""); },
  };
}

function events(body) {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

test("toChatBody: system, tool_use and tool_result keep their order", () => {
  const body = toChatBody({
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: "be brief" }],
    messages: [
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "text", text: "sure" }, { type: "tool_use", id: "toolu_1", name: "ls", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }, { type: "text", text: "thanks" }] },
    ],
    tools: [{ name: "ls", description: "list", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  }, { fallbackModel: "gemini-3.8-flash" });

  assert.equal(body.model, "claude-sonnet-4-5");
  assert.deepEqual(body.messages[0], { role: "system", content: "be brief" });
  assert.equal(body.messages[1].role, "user");
  assert.equal(body.messages[2].role, "assistant");
  assert.equal(body.messages[2].tool_calls[0].id, "toolu_1");
  assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"path":"."}');
  assert.equal(body.messages[3].role, "tool");
  assert.equal(body.messages[3].tool_call_id, "toolu_1");
  assert.equal(body.messages[3].content, "a.txt");
  assert.equal(body.messages[4].role, "user");
  assert.equal(body.tools[0].function.parameters.type, "object");
});

test("toChatBody: images and thinking map onto the internal shape", () => {
  const body = toChatBody({
    model: "x",
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    }],
  }, { fallbackModel: "gemini-3.8-flash" });
  assert.equal(body.model, "x");
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.messages[0].content[1].image_url.url, "data:image/png;base64,AAAA");
});

test("toChatBody: empty model falls back, disabled thinking maps to low", () => {
  const body = toChatBody({ model: "", thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }] }, { fallbackModel: "gemini-3.8-flash" });
  assert.equal(body.model, "gemini-3.8-flash");
  assert.equal(body.reasoning_effort, "low");
});

test("estimateTokens counts text, images and tools", () => {
  const tokens = estimateTokens({
    system: "a".repeat(400),
    messages: [{ role: "user", content: [{ type: "text", text: "b".repeat(400) }, { type: "image", source: { type: "base64", data: "x" } }] }],
    tools: [{ name: "t", input_schema: {} }],
  });
  assert.ok(tokens >= 200 + 1600, `expected at least the image cost, got ${tokens}`);
});

test("toAnthropicUsage keeps cache reads out of input_tokens", () => {
  assert.deepEqual(toAnthropicUsage({ prompt: 100, completion: 7, cacheRead: 40, cacheWrite: 10 }), {
    input_tokens: 50,
    output_tokens: 7,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 10,
  });
});

test("AnthropicOutput streams thinking, text and tool_use blocks", () => {
  const res = fakeRes();
  const out = new AnthropicOutput(res, { stream: true, model: "gemini-3.8-flash" });
  out.emitReasoning("thinking");
  out.emitText("hello");
  out.emitToolCall(0, { id: "call_1", name: "ls", argumentsJson: '{"path":"."}' });
  out.finish("tool_calls", { prompt: 100, completion: 10, cacheRead: 40, cacheWrite: 0, reasoning: 5 });

  assert.equal(res.status, 200);
  const list = events(res.body());
  assert.equal(list[0].event, "message_start");
  assert.deepEqual(list.map((e) => e.event), [
    "message_start",
    "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  assert.equal(list[1].data.content_block.type, "thinking");
  assert.equal(list[4].data.content_block.type, "text");
  assert.equal(list[7].data.content_block.type, "tool_use");
  assert.equal(list[8].data.delta.partial_json, '{"path":"."}');
  assert.equal(list[10].data.delta.stop_reason, "tool_use");
  assert.equal(list[10].data.usage.input_tokens, 60);
  assert.equal(list[10].data.usage.output_tokens, 10);
});

test("AnthropicOutput non-streaming returns a message body", () => {
  const res = fakeRes();
  const out = new AnthropicOutput(res, { stream: false, model: "gemini-3.8-flash" });
  out.emitText("hi");
  out.finish("stop", { prompt: 10, completion: 2 });
  const body = JSON.parse(res.body());
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "hi");
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.usage.input_tokens, 10);
});

test("AnthropicOutput maps errors to Anthropic error shapes", () => {
  const res = fakeRes();
  const out = new AnthropicOutput(res, { stream: true, model: "gemini-3.8-flash" });
  out.fail(new BridgeError("AUTH", "sign in"));
  assert.equal(res.status, 401);
  const body = JSON.parse(res.body());
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "authentication_error");
});

test("AnthropicOutput sets x-agy-degraded on non-streaming responses", () => {
  const res = fakeRes();
  const out = new AnthropicOutput(res, { stream: false, model: "gemini-3.8-flash" });
  out.degraded = true;
  out.emitText("hi");
  out.finish("stop", { prompt: 1, completion: 1 });
  assert.equal(res.headers["x-agy-degraded"], "1");
});
