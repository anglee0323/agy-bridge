import assert from "node:assert/strict";
import { test } from "node:test";
import { ResponsesOutput, customInput, customToolDescription, toChatBody, toResponsesUsage } from "../lib/responses.mjs";
import { AGENT_INVALID_OUTPUT_NOTICE, AGENT_RETRY_NOTICE, classifyOutputLimitNotice } from "../lib/transcript.mjs";
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

test("toChatBody: instructions and a plain string input", () => {
  const body = toChatBody({ model: "gpt-5.1-codex", instructions: "be terse", input: "hello" }, { fallbackModel: "gemini-3.8-flash" });
  assert.equal(body.model, "gpt-5.1-codex");
  assert.deepEqual(body.messages[0], { role: "system", content: "be terse" });
  assert.deepEqual(body.messages[1], { role: "user", content: "hello" });
});

test("toChatBody: parallel calls share one assistant message and outputs map to tool messages", () => {
  const body = toChatBody({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: '{"cmd":"ls"}' },
      { type: "function_call", call_id: "c2", name: "shell", arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: "c1", output: "a.txt" },
      { type: "function_call_output", call_id: "c2", output: "/tmp" },
    ],
  }, { fallbackModel: "gemini-3.8-flash" });
  const assistant = body.messages[1];
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.tool_calls.map((c) => c.id), ["c1", "c2"]);
  assert.equal(body.messages[2].role, "tool");
  assert.equal(body.messages[2].tool_call_id, "c1");
  assert.equal(body.messages[3].content, "/tmp");
});

test("toChatBody: custom tools become single-string functions and keep their names", () => {
  const body = toChatBody({
    input: "patch it",
    tools: [
      { type: "function", name: "shell", description: "run", parameters: { type: "object", properties: {} } },
      { type: "custom", name: "apply_patch", description: "freeform patch", format: { type: "grammar" } },
      { type: "web_search" },
    ],
  }, { fallbackModel: "gemini-3.8-flash" });
  assert.equal(body.tools.length, 2);
  const patch = body.tools.find((t) => t.function.name === "apply_patch");
  assert.equal(patch.function.parameters.required[0], "input");
  assert.deepEqual([...body.customTools], ["apply_patch"]);
});

test("toChatBody: custom_tool_call input is carried as {input} and restored", () => {
  const body = toChatBody({
    input: [
      { type: "message", role: "user", content: "patch" },
      { type: "custom_tool_call", call_id: "c9", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "c9", output: "ok" },
    ],
  }, { fallbackModel: "gemini-3.8-flash" });
  const args = JSON.parse(body.messages[1].tool_calls[0].function.arguments);
  assert.equal(args.input, "*** Begin Patch\n*** End Patch");
  assert.equal(body.messages[2].content, "ok");
});

test("customInput unwraps objects, single strings and raw text", () => {
  assert.equal(customInput('{"input":"raw"}'), "raw");
  assert.equal(customInput('{"patch":"raw"}'), "raw");
  assert.equal(customInput('"raw"'), "raw");
  assert.equal(customInput("*** Begin Patch"), "*** Begin Patch");
  assert.equal(customInput(""), "");
});

test("toResponsesUsage maps cache and reasoning details", () => {
  assert.deepEqual(toResponsesUsage({ prompt: 100, completion: 20, cacheRead: 40, reasoning: 5 }), {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 5 },
    total_tokens: 120,
  });
});

test("ResponsesOutput streams reasoning, text, function_call and custom_tool_call", () => {
  const res = fakeRes();
  const out = new ResponsesOutput(res, { stream: true, model: "gemini-3.8-flash", customTools: new Set(["apply_patch"]) });
  out.emitReasoning("thinking");
  out.emitText("hello");
  out.emitToolCall(0, { id: "c1", name: "shell", argumentsJson: '{"cmd":"ls"}' });
  out.emitToolCall(1, { id: "c2", name: "apply_patch", argumentsJson: '{"input":"*** Begin Patch"}' });
  out.finish("tool_calls", { prompt: 100, completion: 20, cacheRead: 40, reasoning: 5 });

  const list = events(res.body());
  assert.equal(list[0].event, "response.created");
  assert.ok(list.some((e) => e.event === "response.reasoning_summary_text.delta"));
  assert.ok(list.some((e) => e.event === "response.output_text.delta" && e.data.delta === "hello"));
  assert.ok(list.some((e) => e.event === "response.function_call_arguments.delta" && e.data.delta === '{"cmd":"ls"}'));
  assert.ok(list.some((e) => e.event === "response.custom_tool_call_input.delta" && e.data.delta === "*** Begin Patch"));

  const completed = list.find((e) => e.event === "response.completed");
  assert.equal(completed.data.response.status, "completed");
  assert.deepEqual(completed.data.response.output.map((i) => i.type), ["reasoning", "message", "function_call", "custom_tool_call"]);
  assert.equal(completed.data.response.output[1].content[0].text, "hello");
  assert.equal(completed.data.response.output[3].input, "*** Begin Patch");
  assert.equal(completed.data.response.usage.input_tokens, 100);
  assert.equal(completed.data.response.usage.output_tokens, 20);
  assert.equal(completed.data.response.usage.input_tokens_details.cached_tokens, 40);
});

test("ResponsesOutput non-streaming returns the response object", () => {
  const res = fakeRes();
  const out = new ResponsesOutput(res, { stream: false, model: "gemini-3.8-flash" });
  out.emitText("hi");
  out.finish("stop", { prompt: 10, completion: 2 });
  const body = JSON.parse(res.body());
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.output[0].type, "message");
  assert.equal(body.output[0].content[0].text, "hi");
  assert.equal(body.usage.total_tokens, 12);
});

test("ResponsesOutput maps errors to Responses error shapes", () => {
  const res = fakeRes();
  const out = new ResponsesOutput(res, { stream: true, model: "gemini-3.8-flash" });
  out.fail(new BridgeError("AUTH", "sign in"));
  assert.equal(res.status, 401);
  const body = JSON.parse(res.body());
  assert.equal(body.error.type, "authentication_error");
});

test("ResponsesOutput marks degraded non-streaming responses", () => {
  const res = fakeRes();
  const out = new ResponsesOutput(res, { stream: false, model: "gemini-3.8-flash" });
  out.degraded = true;
  out.emitText("hi");
  out.finish("stop", { prompt: 1, completion: 1 });
  assert.equal(res.headers["x-agy-degraded"], "1");
});

test("customToolDescription replaces the freeform contract but keeps the tool semantics", () => {
  const text = customToolDescription("Apply a patch. This is a FREEFORM tool, do not wrap the patch in JSON. Use *** Begin Patch.");
  assert.match(text, /Apply a patch/);
  assert.match(text, /\*\*\* Begin Patch/);
  assert.doesNotMatch(text, /do not wrap/i);
  assert.match(text, /"input" field/);
  assert.match(customToolDescription(""), /"input" field/);
});

test("agy notices are recognised and never forwarded as model text", () => {
  assert.ok(AGENT_INVALID_OUTPUT_NOTICE.test("\n⚠ Model produced invalid output.\n"));
  assert.ok(AGENT_RETRY_NOTICE.test("⚠ API error (attempt 2)"));
  assert.ok(!AGENT_INVALID_OUTPUT_NOTICE.test("The model produced invalid output? Let me explain."));
});

test("a chunked invalid-output notice is held and then dropped", () => {
  assert.equal(classifyOutputLimitNotice("⚠ Model produced"), "hold");
  assert.equal(classifyOutputLimitNotice("⚠ Model produced invalid output."), "drop");
  assert.equal(classifyOutputLimitNotice("Model produced"), "hold");
  assert.equal(classifyOutputLimitNotice("Model produced a patch:"), "emit");
});
