// 端到端：扮演一个 OpenAI 兼容的 harness，对真实 agy 跑一遍（会消耗少量额度，不切账号）。
import assert from "node:assert/strict";

const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8789";
const MODEL = process.env.BRIDGE_MODEL ?? "gemini-3.8-flash";
const EFFORT = "low";

const TOOLS = [
  { type: "function", function: { name: "get_secret_word", description: "Returns today's secret word.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "add_numbers", description: "Adds two integers.", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] } } },
];

async function health() {
  return (await fetch(`${BASE}/health`)).json();
}

async function chat(messages, { tools, stream = true, signal, abortAfterFirstChunk = false } = {}) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, reasoning_effort: EFFORT, messages, tools, stream, stream_options: { include_usage: true } }),
    signal,
  });
  if (!stream) return { status: res.status, body: await res.json() };
  if (res.status !== 200) return { status: res.status, body: await res.json() };
  const out = { status: 200, content: "", reasoning: "", toolCalls: [], finish: null, usage: null, error: null };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      if (chunk.error) { out.error = chunk.error; continue; }
      if (chunk.usage) out.usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) out.content += choice.delta.content;
      if (choice.delta?.reasoning_content) out.reasoning += choice.delta.reasoning_content;
      for (const tc of choice.delta?.tool_calls ?? []) out.toolCalls.push(tc);
      if (choice.finish_reason) out.finish = choice.finish_reason;
      if (abortAfterFirstChunk && (out.content || out.reasoning)) { await reader.cancel(); return out; }
    }
  }
  return out;
}

const assistantFrom = (r) => ({
  role: "assistant",
  content: r.content || null,
  ...(r.toolCalls.length ? { tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: "function", function: t.function })) } : {}),
});

function runTool(tc) {
  const args = JSON.parse(tc.function.arguments || "{}");
  if (tc.function.name === "get_secret_word") return "PERSIMMON";
  if (tc.function.name === "add_numbers") return String(Number(args.a) + Number(args.b));
  return `unknown tool ${tc.function.name}`;
}

const SYSTEM = { role: "system", content: "You are a terse test assistant. Follow instructions exactly." };
const step = (name) => console.log(`\n== ${name}`);

// 1. 纯文本
step("plain text (rebuild)");
let before = await health();
const m1 = [SYSTEM, { role: "user", content: "Reply with exactly the word: pong" }];
const r1 = await chat(m1);
console.log(JSON.stringify({ content: r1.content, finish: r1.finish, usage: r1.usage }));
assert.equal(r1.status, 200);
assert.match(r1.content, /pong/i);
assert.equal(r1.finish, "stop");
assert.ok(r1.usage?.prompt_tokens > 0, "usage reported");
let after = await health();
assert.equal(after.stats.rebuilds - before.stats.rebuilds, 1);

// 2. 同一对话续写：只发增量，不重建
step("follow-up (append, no rebuild)");
before = after;
const m2 = [...m1, assistantFrom(r1), { role: "user", content: "What word did you just reply with? Answer with that single word only." }];
const r2 = await chat(m2);
console.log(JSON.stringify({ content: r2.content, finish: r2.finish }));
assert.match(r2.content, /pong/i);
after = await health();
assert.equal(after.stats.appends - before.stats.appends, 1, "should append");
assert.equal(after.stats.rebuilds - before.stats.rebuilds, 0, "should not rebuild");

// 3. 工具闭环（含并行），宿主执行，结果回填到同一轮
step("tool loop (resume)");
before = after;
let msgs = [SYSTEM, { role: "user", content: "Call get_secret_word and add_numbers with a=2 and b=3 (call both at once if you can). Then reply exactly '<WORD> <SUM>'." }];
let final;
for (let round = 0; round < 5; round++) {
  const r = await chat(msgs, { tools: TOOLS });
  assert.equal(r.status, 200, JSON.stringify(r.body ?? r.error));
  console.log(`round ${round}: finish=${r.finish} calls=${r.toolCalls.map((t) => t.function.name).join(",")} content=${JSON.stringify(r.content)} prompt=${r.usage?.prompt_tokens}`);
  msgs = [...msgs, assistantFrom(r)];
  if (r.finish !== "tool_calls") { final = r; break; }
  for (const tc of r.toolCalls) msgs.push({ role: "tool", tool_call_id: tc.id, content: runTool(tc) });
}
assert.ok(final, "loop ended");
assert.match(final.content, /PERSIMMON/);
assert.match(final.content, /\b5\b/);
after = await health();
assert.ok(after.stats.resumes - before.stats.resumes >= 1, "resumed parked turn");
assert.equal(after.stats.rebuilds - before.stats.rebuilds, 1, "only the first request rebuilds");

// 4. 非流式 + 工具
step("non-stream tool call");
const ns = await chat([SYSTEM, { role: "user", content: "Call get_secret_word now." }], { tools: TOOLS, stream: false });
console.log(JSON.stringify(ns.body.choices?.[0]));
assert.equal(ns.status, 200);
assert.equal(ns.body.choices[0].finish_reason, "tool_calls");
const nsCall = ns.body.choices[0].message.tool_calls[0];
const ns2 = await chat([
  SYSTEM,
  { role: "user", content: "Call get_secret_word now." },
  { role: "assistant", content: null, tool_calls: [nsCall] },
  { role: "tool", tool_call_id: nsCall.id, content: "PERSIMMON" },
], { tools: TOOLS, stream: false });
console.log(JSON.stringify(ns2.body.choices?.[0]?.message?.content));
assert.match(ns2.body.choices[0].message.content ?? "", /PERSIMMON/);

// 5. 中断：客户端断开后取消上游这一轮
step("client abort");
before = await health();
const controller = new AbortController();
await chat([SYSTEM, { role: "user", content: "Write a 600-word story about a lighthouse." }], { signal: controller.signal, abortAfterFirstChunk: true }).catch(() => {});
controller.abort();
await new Promise((r) => setTimeout(r, 1500));
after = await health();
assert.equal(after.stats.aborts - before.stats.aborts, 1);

// 6. 错误码与跨站拦截
step("errors and guards");
const bad = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }) });
assert.equal(bad.status, 404);
const cors = await fetch(`${BASE}/v1/models`, { headers: { origin: "https://evil.example" } });
assert.equal(cors.status, 403);
const plain = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
assert.equal(plain.status, 400);

console.log("\nPASS", JSON.stringify((await health()).stats));
