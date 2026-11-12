/**
 * OpenAI chat 消息 → 内部消息、会话指纹、历史重放与工具声明压缩。
 */
import { BridgeError, sha1 } from "./util.mjs";

export const MCP_SERVER = "host";
export const PREFIX = `mcp_${MCP_SERVER}_`;
export const CALL_TOOL_NAME = "bridge_call_tool";
export const AWAIT_TOOL_NAME = "bridge_await_result";
/** 未打补丁的 agy 对单条 USER_INPUT 有 192KB 截断线，重放留足余量 */
export const REPLAY_BUDGET_BYTES = 160_000;
export const EMPTY_INPUT_CONTINUATION = "Continue the task from the latest tool results above.";
export const CONTINUE_PROMPT = "Continue exactly where you stopped.";

const HISTORY_OPEN = "<conversation_history>\n";
const HISTORY_CLOSE = "\n</conversation_history>\n\n";
const OMISSION_RESERVE = 128;

// ---------- 消息归一化 ----------

function partsText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p?.type === "text" || p?.type === "input_text" ? p.text ?? "" : "")).join("");
}

function partsImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (part?.type !== "image_url") continue;
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url ?? "");
    if (match) out.push({ mimeType: match[1], data: match[2] });
    else if (url) out.push({ url });
  }
  return out;
}

/** 开头连续的 system/developer 合成系统提示；中途出现的作为 system 消息保留在历史里。 */
export function normalizeMessages(raw) {
  if (!Array.isArray(raw)) throw new BridgeError("BAD_REQUEST", "messages must be an array");
  const systemParts = [];
  const messages = [];
  let leading = true;
  for (const m of raw) {
    const role = m?.role;
    if ((role === "system" || role === "developer") && leading) {
      const text = partsText(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    leading = false;
    if (role === "system" || role === "developer") {
      messages.push({ role: "system", text: partsText(m.content), images: [] });
    } else if (role === "user") {
      messages.push({ role: "user", text: partsText(m.content), images: partsImages(m.content) });
    } else if (role === "assistant") {
      const toolCalls = (Array.isArray(m.tool_calls) ? m.tool_calls : [])
        .filter((c) => c?.function?.name)
        .map((c) => ({
          id: String(c.id ?? ""),
          name: c.function.name,
          arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
        }));
      messages.push({ role: "assistant", text: partsText(m.content), images: [], toolCalls });
    } else if (role === "tool" || role === "function") {
      messages.push({ role: "tool", toolCallId: String(m.tool_call_id ?? ""), text: partsText(m.content), images: partsImages(m.content) });
    }
  }
  return { system: systemParts.join("\n\n"), messages };
}

/**
 * 会话指纹：判断“这次请求是不是某个活会话的续写”。
 * 助手消息只认工具调用 id，不认正文——各家 harness 回传正文时会改格式（trim、合并），id 不会变。
 */
export function fingerprint(m) {
  switch (m.role) {
    case "user": return `u:${sha1(`${m.text}\0${m.images.map((i) => (i.data ? sha1(i.data) : i.url)).join(",")}`)}`;
    case "system": return `s:${sha1(m.text)}`;
    case "assistant": return `a:${m.toolCalls.map((c) => c.id).join(",")}`;
    case "tool": return `t:${m.toolCallId}`;
    default: return "?";
  }
}

export function isPrefix(prefix, list) {
  if (prefix.length > list.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== list[i]) return false;
  return true;
}

export function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ---------- 系统提示 ----------

export function preamble(system, hasTools) {
  const lines = hasTools
    ? [
        "You are the model behind an external coding harness. The harness owns the conversation, the tools, and their permissions; you act only through the harness tools.",
        `Every harness tool is available to you under the prefix \`${PREFIX}\`: a tool named \`X\` in the instructions below is the tool \`${PREFIX}X\`. If \`${PREFIX}X\` is absent from your direct tool declarations, invoke it via \`${PREFIX}${CALL_TOOL_NAME}\` with \`{"name":"X","arguments":{...}}\`. Pass arguments exactly as each schema defines. Do not use any other tools.`,
        "When the first user message contains a <conversation_history> block, it reproduces the earlier part of this conversation; continue from the newest input after it without repeating completed actions.",
      ]
    : [
        "You are the model behind an external harness. No tools are available for this request; answer directly.",
        "When the first user message contains a <conversation_history> block, it reproduces the earlier part of this conversation; continue from the newest input after it.",
      ];
  const head = lines.join("\n");
  return system ? `${head}\n\n${system}` : head;
}

// ---------- 历史渲染与重放 ----------

const imageNote = (m) => (m.images?.length ? `\n[${m.images.length} image(s) omitted]` : "");

export function renderMessage(m) {
  switch (m.role) {
    case "user": return `<user>\n${m.text}${imageNote(m)}\n</user>`;
    case "system": return `<system_update>\n${m.text}\n</system_update>`;
    case "assistant": {
      const parts = [];
      if (m.text.trim()) parts.push(`<assistant>\n${m.text}\n</assistant>`);
      for (const c of m.toolCalls) parts.push(`<tool_call id="${c.id}" name="${PREFIX}${c.name}">\n${c.arguments}\n</tool_call>`);
      return parts.join("\n\n");
    }
    case "tool": return `<tool_result id="${m.toolCallId}">\n${m.text}${imageNote(m)}\n</tool_result>`;
    default: return "";
  }
}

export function renderTranscript(messages) {
  return messages.map(renderMessage).filter(Boolean).join("\n\n");
}

const bytes = (text) => Buffer.byteLength(text, "utf8");

function headWithinBytes(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] ?? 0) >= 0x80 && (buf[end] ?? 0) < 0xc0) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** 从新到旧装入预算，超出的最旧部分省略并在块内注明。 */
function historyBlock(history, budget) {
  const parts = [];
  let used = 0;
  let dropped = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const rendered = renderMessage(m);
    if (!rendered) continue;
    const sep = parts.length === 0 ? 0 : 2;
    const size = bytes(rendered);
    if (used + sep + size > budget) {
      if (parts.length === 0 && m.role === "tool" && budget > 1024) {
        const marker = "\n[tool result truncated to fit the replay budget]";
        const head = headWithinBytes(m.text, budget - bytes(marker) - 64);
        parts.unshift(renderMessage({ ...m, text: `${head}${marker}`, images: [] }));
        dropped = i;
      } else {
        dropped = i + 1;
      }
      break;
    }
    parts.unshift(rendered);
    used += sep + size;
  }
  if (dropped > 0) parts.unshift(`[Earlier ${dropped} history messages omitted to fit the replay budget]`);
  return parts.length ? `${HISTORY_OPEN}${parts.join("\n\n")}${HISTORY_CLOSE}` : "";
}

function imageBlocks(images) {
  return images.map((i) => (i.data ? { type: "image", data: i.data, mimeType: i.mimeType } : { type: "text", text: `[image: ${i.url}]` }));
}

/** 新输入（用户消息、中途的系统更新）→ ACP prompt 块 */
export function inputBlocks(input) {
  const blocks = [];
  for (const m of input) {
    if (m.role === "user") {
      if (m.text) blocks.push({ type: "text", text: m.text });
      blocks.push(...imageBlocks(m.images));
    } else {
      const text = renderMessage(m);
      if (text) blocks.push({ type: "text", text });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "Continue." });
  return blocks;
}

/** 重建会话：较早历史渲染成转录，末尾的用户输入作为实时内容完整保留。 */
export function replayBlocks(history, input, budget = REPLAY_BUDGET_BYTES) {
  const live = input.length ? inputBlocks(input) : [{ type: "text", text: EMPTY_INPUT_CONTINUATION }];
  const blocks = [];
  if (history.length) {
    const liveBytes = live.reduce((n, b) => n + (b.type === "text" ? bytes(b.text) : 0), 0);
    const overhead = bytes(HISTORY_OPEN) + bytes(HISTORY_CLOSE) + OMISSION_RESERVE;
    const text = historyBlock(history, Math.max(0, budget - liveBytes - overhead));
    if (text) blocks.push({ type: "text", text });
  }
  blocks.push(...live);
  return blocks;
}

// ---------- 工具声明 ----------

/** agy 对超过约 1.5KB 的 MCP 工具声明会改为懒加载，压到阈值以下让每个工具都直接可见 */
const MAX_EAGER_TOOL_BYTES = 1_350;

function shorten(text, max) {
  const clean = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  const end = clean.indexOf(". ");
  if (end >= 32 && end + 1 <= max) return clean.slice(0, end + 1);
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function compactNode(value, maxDesc) {
  if (Array.isArray(value)) return value.map((v) => compactNode(v, maxDesc));
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "description" && typeof entry === "string") {
      if (maxDesc > 0) out[key] = shorten(entry, maxDesc);
      continue;
    }
    out[key] = compactNode(entry, maxDesc);
  }
  return out;
}

function compactTool(tool) {
  if (bytes(JSON.stringify(tool)) <= MAX_EAGER_TOOL_BYTES) return tool;
  const pass1 = { name: tool.name, description: shorten(tool.description, 220), inputSchema: compactNode(tool.inputSchema, 90) };
  if (bytes(JSON.stringify(pass1)) <= MAX_EAGER_TOOL_BYTES) return pass1;
  return { name: tool.name, description: shorten(tool.description, 140), inputSchema: compactNode(tool.inputSchema, 0) };
}

export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t?.type === "function" && typeof t.function?.name === "string")
    .map((t) => {
      const params = t.function.parameters && typeof t.function.parameters === "object" ? t.function.parameters : {};
      return compactTool({
        name: t.function.name,
        description: String(t.function.description ?? ""),
        inputSchema: params.type === undefined ? { type: "object", ...params } : params,
      });
    });
}

export const AWAIT_TOOL = {
  name: AWAIT_TOOL_NAME,
  description: "Wait for the result of a harness tool call that reported it is still running. Call this only when a tool result tells you to, passing the call_id it gave.",
  inputSchema: { type: "object", properties: { call_id: { type: "string", description: "The call id from the still-running notice." } }, required: ["call_id"] },
};

export const CALL_TOOL = {
  name: CALL_TOOL_NAME,
  description: `Invoke any harness tool by exact name when ${PREFIX}<name> is absent from your direct tool declarations.`,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: `Exact harness tool name without the ${PREFIX} prefix.` },
      arguments: { type: "object", description: "Arguments object matching that tool schema." },
    },
    required: ["name"],
  },
};

export function relayNotice(call) {
  return {
    content: [{
      type: "text",
      text: `The harness is still running tool call ${call.id} (${call.name}). Call ${PREFIX}${AWAIT_TOOL_NAME} with {"call_id":"${call.id}"} now to receive its result. Do not repeat the original call and do not answer the user before the result arrives.`,
    }],
  };
}

// ---------- agy 自带的续写提示过滤 ----------

const OUTPUT_LIMIT_HEAD = "your previous response was cut off because it exceeded the output token limit";
const OUTPUT_LIMIT_TAIL = "please continue from where you left off, keeping your response shorter";
/** agy 自己的告警文案：模型输出非法（freeform 工具参数不是 JSON 时常见） */
const INVALID_OUTPUT_HEAD = "model produced invalid output";
export const AGENT_RETRY_NOTICE = /^\s*⚠\s*API error \(attempt \d+\)/;
/** agy 自己的告警：模型输出非法（例如 freeform 工具参数不是 JSON），不是给用户的正文 */
export const AGENT_INVALID_OUTPUT_NOTICE = /^\s*⚠\s*Model produced invalid output\b/i;

function noticeText(raw) {
  return raw.replace(/⚠/g, " ").replace(/\bError:/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** drop = 只是 agy 的输出上限提示；hold = 还可能是它的前缀；emit = 模型正文 */
export function classifyOutputLimitNotice(raw) {
  const text = noticeText(raw);
  if (!text) return "emit";
  const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, "").trim();
  const retry = text.slice(stripped.length).trim();
  if (retry && !/^retries remaining:\s*\d*$/i.test(retry)) return "emit";
  if (!stripped) return /^retries remaining:\s*\d+$/i.test(text) ? "drop" : "emit";
  // 分片到达的 “Model produced invalid output.” 也要先扣住，避免半句漏给客户端
  if (INVALID_OUTPUT_HEAD.startsWith(text)) return "hold";
  if (text.startsWith(INVALID_OUTPUT_HEAD)) return "drop";
  const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`;
  if (stripped === full || stripped === OUTPUT_LIMIT_HEAD || stripped === OUTPUT_LIMIT_TAIL) return "drop";
  if (full.startsWith(stripped) && stripped.startsWith("your previous")) return "hold";
  if (OUTPUT_LIMIT_TAIL.startsWith(stripped) && stripped.startsWith("please continue from where you left off")) return "hold";
  if ("retries remaining:".startsWith(text) && text.startsWith("retries")) return "hold";
  return "emit";
}
