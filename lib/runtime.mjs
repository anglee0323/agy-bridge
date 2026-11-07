/**
 * 桥的核心：一个 agy acp 进程、一个回环 MCP 服务、若干会话（conversation）。
 *
 * OpenAI chat 接口是无状态的（每次带全量历史），ACP 会话是有状态的。按“指纹前缀”把请求映射到活会话：
 *   resume  —— 请求带回了某个挂起工具调用的结果：回填给 MCP，同一轮 ACP 生成继续往下跑
 *   append  —— 某个会话的已知历史是本次请求的前缀，多出来的只有用户输入：只发增量
 *   rebuild —— 都不是：新开 ACP 会话，较早历史以转录形式重放，最新输入作为实时内容
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AcpProcess } from "./acp.mjs";
import { McpServer } from "./mcp.mjs";
import { peekMaxStepIdx, readStepsAfter } from "./usage-db.mjs";
import { keychainRead } from "./credstore.mjs";
import { switchTo } from "./switcher.mjs";
import { listAccounts, findCurrentAccount } from "./vault.mjs";
import { loadState, mutateState } from "./state.mjs";
import { refreshQuota } from "./homes.mjs";
import {
  accountBlock, banCooldownMs, blockedUntil, classifyAccountError, classifyNotice, familyOf, pickNext,
} from "./pool.mjs";
import {
  AGENT_RETRY_NOTICE, AWAIT_TOOL, AWAIT_TOOL_NAME, CALL_TOOL, CALL_TOOL_NAME, CONTINUE_PROMPT, MCP_SERVER, PREFIX,
  classifyOutputLimitNotice, commonPrefix, fingerprint, inputBlocks, isPrefix, normalizeMessages, normalizeTools,
  preamble, relayNotice, renderMessage, renderTranscript, replayBlocks,
} from "./transcript.mjs";
import { AsyncQueue, BridgeError, deferred, delay, isRecord, log, mapError, sha1 } from "./util.mjs";

const AGENT = "harness-bridge";
const EFFORTS = ["low", "medium", "high"];
const FIXED_EFFORT = /-(low|medium|high)$/;

// ---------- 一轮 ACP 生成 ----------

class Turn {
  events = new AsyncQueue();
  /** 已交给 harness、还没拿到结果的工具调用 */
  pending = new Map();
  /** 本轮出现过的全部工具调用（await 中继用） */
  calls = new Map();
  finished = false;
  relaying = false;
  produced = false;
  continuations = 0;
  toolSteps = 0;
  #noticeHold = "";
  /** 输出开头扣留：agy 会把封禁/额度通知包装成正常回复，先扣住辨认，不足 96 字或命中文案前不外发 */
  holding = true;
  heldText = "";

  absorb(text) {
    if (!this.holding) return null;
    this.heldText += text;
    if (classifyNotice(this.heldText)) return "verdict";
    if (this.heldText.length < 96) return "hold";
    this.holding = false;
    return { flush: this.heldText };
  }

  flushHeld() {
    if (!this.holding || !this.heldText) return null;
    this.holding = false;
    return this.heldText;
  }

  park(name, args) {
    const call = { id: `call_${randomBytes(8).toString("hex")}`, name, argumentsJson: JSON.stringify(args ?? {}), result: deferred(), relays: 0 };
    this.calls.set(call.id, call);
    this.events.push({ kind: "park", call });
    return call;
  }

  onUpdate(update) {
    const text = update.content?.type === "text" ? update.content.text ?? "" : "";
    if (update.sessionUpdate === "agent_message_chunk" && text) {
      this.#consumeMessage(text);
    } else if (update.sessionUpdate === "agent_thought_chunk") {
      const held = this.recoverNoticeHold();
      if (held && !this.relaying) this.events.push({ kind: "text", text: held });
      if (text && !this.relaying) this.events.push({ kind: "thought", text });
    }
  }

  #consumeMessage(text) {
    const combined = this.#noticeHold + text;
    const kind = classifyOutputLimitNotice(combined);
    if (kind === "hold") { this.#noticeHold = combined; return; }
    this.#noticeHold = "";
    if (kind === "drop" || AGENT_RETRY_NOTICE.test(combined)) return;
    // 中继等待期间 agent 可能说“我在等结果”，这些不是给用户的正文
    if (!this.relaying) this.events.push({ kind: "text", text: combined });
  }

  recoverNoticeHold() {
    if (!this.#noticeHold) return "";
    const held = this.#noticeHold;
    this.#noticeHold = "";
    if (classifyOutputLimitNotice(held) === "drop") return "";
    return this.relaying ? "" : held;
  }

  abandon(reason) {
    for (const call of this.calls.values()) call.result.resolve({ content: [{ type: "text", text: reason }], isError: true });
    this.pending.clear();
  }
}

const isTurnLive = (turn) => {
  const head = turn.events.peek();
  return head?.kind !== "done" && head?.kind !== "error";
};

function usageFromResult(u, calls) {
  if (!u) return undefined;
  const scale = Math.max(1, calls);
  const input = Math.round((u.inputTokens ?? 0) / scale);
  const cacheRead = Math.round((u.cachedReadTokens ?? 0) / scale);
  const cacheWrite = Math.round((u.cachedWriteTokens ?? 0) / scale);
  return { prompt: input + cacheRead + cacheWrite, cacheRead, cacheWrite, completion: u.outputTokens ?? 0, reasoning: u.thoughtTokens ?? 0 };
}

function nearestEffort(wanted, offered) {
  if (!offered?.length || offered.includes(wanted)) return wanted;
  const d = (e) => Math.abs(EFFORTS.indexOf(e) - EFFORTS.indexOf(wanted));
  return [...offered].sort((a, b) => d(a) - d(b))[0];
}

function mapEffort(raw) {
  if (typeof raw !== "string") return undefined;
  const v = raw.toLowerCase();
  if (["none", "off", "minimal", "low"].includes(v)) return "low";
  if (v === "medium") return "medium";
  if (["high", "xhigh", "max"].includes(v)) return "high";
  return undefined;
}

// ---------- Runtime ----------

export class Runtime {
  constructor(cfg) {
    this.cfg = cfg;
    this.home = cfg.home;
    this.workspace = join(cfg.home, "workspace");
    this.catalogPath = join(cfg.home, "..", "catalog.json");
    this.proc = undefined;
    this.starting = undefined;
    this.convs = new Map();
    this.tenants = new Map();
    this.catalog = this.#loadCatalog();
    this.stats = { requests: 0, rebuilds: 0, appends: 0, resumes: 0, toolCalls: 0, errors: 0, aborts: 0 };
    this.mcp = new McpServer({
      authorize: (tenant, token) => this.#authorize(tenant, token),
      listTools: (tenant) => {
        const conv = this.tenants.get(tenant);
        return conv ? [...conv.tools, AWAIT_TOOL, CALL_TOOL] : [];
      },
      callTool: (req) => this.#callTool(req),
    }, { log });
    this.sweeper = setInterval(() => this.#sweep(), 60_000);
    this.sweeper.unref();
    this.autoSwitch = cfg.autoSwitch !== false;
    this.switching = false;
    this.rotating = null;
    this.lastRotateAt = 0;
    this.lastQuotaCheck = 0;
    this.quotaChecking = false;
    this.quotaTimer = null;
  }

  // ----- 进程 -----

  #prepareHome() {
    const agentDir = join(this.home, "config", "plugins", AGENT, "agents");
    mkdirSync(agentDir, { recursive: true });
    writeIfChanged(join(this.home, "config", "plugins", AGENT, "plugin.json"), `${JSON.stringify({ name: AGENT }, null, 2)}\n`);
    // 内层 agent 不带任何内置工具，只能通过注入的宿主工具行动
    writeIfChanged(join(agentDir, `${AGENT}.md`), [
      "---",
      `name: ${AGENT}`,
      'description: "Harness bridge: no built-in tools, harness tools only"',
      "tools: []",
      "excludeDefaultComponents: true",
      "mainAgent: true",
      "---",
      "Follow the appended system instructions exactly. Act only through the harness tools you are given.",
      "",
    ].join("\n"));
    const appData = join(this.home, "agy");
    mkdirSync(appData, { recursive: true });
    const settingsPath = join(appData, "settings.json");
    let settings = {};
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { settings = {}; }
    writeIfChanged(settingsPath, `${JSON.stringify({ ...settings, toolPermission: "request-review", agentMode: "" }, null, 2)}\n`);
    mkdirSync(this.workspace, { recursive: true });
  }

  ensureReady() {
    if (this.proc?.alive) return Promise.resolve(this.proc);
    this.starting ??= this.#start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async #start() {
    this.#prepareHome();
    await this.mcp.start();
    const argv = [
      this.cfg.agyBin, "acp",
      "--gemini-dir", this.home,
      "--app-data-dir", "agy",
      "--agent", AGENT,
      "--process-per-session",
      "--disable-telemetry",
      "--log-file", join(this.home, "acp.log"),
    ];
    const proc = new AcpProcess({
      argv,
      cwd: this.workspace,
      clientName: "agy-bridge",
      clientVersion: "0.1.0",
      log,
      onExit: (p, error) => this.#onExit(p, error),
    });
    try {
      await proc.start(120_000);
    } catch (error) {
      proc.stop();
      throw mapError(error);
    }
    this.proc = proc;
    log(`agy acp ready (pid ${proc.pid})`);
    return proc;
  }

  #onExit(proc, error) {
    if (this.proc === proc) this.proc = undefined;
    if (!this.disposed) log(`agy acp exited: ${error.message}`);
    for (const conv of this.convs.values()) {
      if (conv.proc !== proc) continue;
      conv.turn?.events.push({ kind: "error", error: new BridgeError("TRANSPORT", `Antigravity ACP process exited: ${error.message}`) });
      this.#releaseTenant(conv);
      conv.sessionId = undefined;
      conv.proc = undefined;
      conv.dirty = true;
    }
  }

  async warmup() {
    const proc = await this.ensureReady();
    this.#prepareHome();
    const r = await proc.newSession({ cwd: this.workspace, mcpServers: [] }, { onUpdate() {} }, 120_000);
    this.#observe(r.configOptions, r.models?.availableModels);
    await proc.closeSession(r.sessionId);
  }

  async dispose() {
    this.disposed = true;
    clearInterval(this.sweeper);
    for (const conv of this.convs.values()) conv.turn?.abandon("The bridge is shutting down.");
    this.convs.clear();
    this.tenants.clear();
    this.proc?.stop();
    await this.mcp.close();
  }

  // ----- 模型目录 -----

  #loadCatalog() {
    try {
      const data = JSON.parse(readFileSync(this.catalogPath, "utf8"));
      if (Array.isArray(data.families)) return { families: data.families, observed: false };
    } catch { /* 首次启动没有缓存 */ }
    return { families: [], observed: false };
  }

  #observe(configOptions, availableModels) {
    const option = configOptions?.find((o) => o.id === "model" || o.category === "model");
    if (!option?.options?.length) return;
    const names = new Map((availableModels ?? []).map((m) => [m.modelId, m.name]));
    const families = option.options.map((o) => {
      const name = names.get(o.value) ?? EFFORTS.map((e) => names.get(`${o.value}-${e}`)).find(Boolean) ?? o.name ?? o.value;
      return { id: o.value, name: String(name).replace(/\s*\((Low|Medium|High)\)\s*$/i, "") };
    });
    const changed = JSON.stringify(families) !== JSON.stringify(this.catalog.families);
    this.catalog = { families, observed: true };
    if (changed) {
      try { writeFileSync(this.catalogPath, `${JSON.stringify({ families, updatedAt: new Date().toISOString() }, null, 2)}\n`); } catch { /* 缓存失败不影响使用 */ }
    }
  }

  listModels() {
    return this.catalog.families;
  }

  resolveModel(id, requestedEffort) {
    const ids = this.catalog.families.map((f) => f.id);
    let family = id;
    let effort;
    if (!ids.includes(family)) {
      const m = /^(.*)-(low|medium|high)$/.exec(id);
      if (m && ids.includes(m[1])) { family = m[1]; effort = m[2]; }
    }
    if (!family) throw new BridgeError("BAD_REQUEST", "model is required");
    if (this.catalog.observed && !ids.includes(family)) {
      throw new BridgeError("UNKNOWN_MODEL", `Unknown model "${id}". Available: ${ids.join(", ")}`);
    }
    return { family, effort: effort ?? mapEffort(requestedEffort) ?? this.cfg.defaultEffort };
  }


  // ----- 主入口 -----

  async chat(body, out, signal) {
    const family = familyOf(this.resolveModel(String(body.model ?? ""), body.reasoning_effort).family);
    if (this.rotating) await this.rotating.catch(() => {});
    if (this.autoSwitch) await this.#preflight(family);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.#chatOnce(body, out, signal);
        await this.#onSuccess(family);
        return result;
      } catch (error) {
        // 账号级错误：标记冷却 → 换号重建 → 重试；候选耗尽才把错误抛给 harness
        if (!this.autoSwitch) throw error;
        const verdict = classifyAccountError(error.message);
        if (!verdict) throw error;
        if (this.rotating) {
          // 别的请求已经在换号：等它换完，再用新号重试
          await this.rotating.catch(() => {});
          if (out.committed) throw error;
          continue;
        }
        if (attempt >= this.#poolSize()) throw error;
        const current = await this.#currentAccountId();
        log(`account error (${verdict}): ${String(error.message).slice(0, 160)}`);
        if (current) await this.#markAccount(current, verdict, family);
        const next = pickNext(listAccounts(), loadState(), { family, excludeId: current });
        if (!next) throw error;
        try {
          await this.#rotateTo(next, verdict);
        } catch (rotateError) {
          // 候选号换不过去（刷新令牌失败等）：记到它头上，下一轮换别的
          if (rotateError.kind === "AUTH") {
            mutateState((s) => { s.cooldowns[next.id] = { until: Date.now() + 24 * 3600_000, reason: "auth" }; });
            log(`candidate ${next.email} unusable (${rotateError.message.slice(0, 100)}); trying another`);
            continue;
          }
          throw rotateError;
        }
        if (out.committed) {
          // 已经输出过内容的这条请求救不回来，但号已换好，下一条请求直接可用
          log(`auto-switch: mid-stream failure, now on ${next.email}; this request still fails`);
          throw error;
        }
        log(`auto-switch: now on ${next.email}, retrying request (attempt ${attempt + 1})`);
      }
    }
  }

  /** 没有任何在途请求与挂起工具调用时才算空闲，主动换号只在空闲时做。 */
  #idle() {
    for (const conv of this.convs.values()) {
      if (conv.busy || (conv.turn && conv.turn.pending.size > 0)) return false;
    }
    return true;
  }

  /** 判定结果写入状态：封禁按次数递增冷却；额度读真实重置时间；限流短冷却；登录失效较长冷却。 */
  async #markAccount(id, verdict, family) {
    const now = Date.now();
    if (verdict === "banned") {
      mutateState((s) => {
        const strikes = (s.banStrikes[id] ?? 0) + 1;
        s.banStrikes[id] = strikes;
        s.cooldowns[id] = { until: now + banCooldownMs(strikes), reason: "banned" };
      });
    } else if (verdict === "auth") {
      mutateState((s) => { s.cooldowns[id] = { until: now + 6 * 3600_000, reason: "auth" }; });
    } else if (verdict === "rate") {
      mutateState((s) => { (s.familyCooldowns[id] ??= {})[family] = now + 5 * 60_000; });
    } else if (verdict === "quota") {
      // 用当前号的 /usage 拿真实重置时间；读不到就保守冷却 1 小时
      let until = 0;
      try {
        until = blockedUntil(await refreshQuota(id), family, now);
      } catch (error) {
        log(`quota read after exhaustion failed: ${error.message}`);
      }
      mutateState((s) => { (s.familyCooldowns[id] ??= {})[family] = until > now ? until : now + 3600_000; });
    }
  }

  /** 排他地把登录槽位切到 next。同一时刻只会有一次在进行，其它请求等它结束。 */
  #rotateTo(next, why) {
    if (this.rotating) return this.rotating;
    this.switching = true;
    log(`rotate -> ${next.email} (${why})`);
    this.rotating = (async () => {
      try {
        this.proc?.stop();
        this.proc = undefined;
        await switchTo(next.id);
        mutateState((s) => { s.currentAccountId = next.id; });
        this.currentAccountIdCached = next.id;
        this.lastRotateAt = Date.now();
        await this.ensureReady();
      } finally {
        this.switching = false;
        this.rotating = null;
      }
    })();
    return this.rotating;
  }

  #poolSize() {
    return listAccounts().filter((a) => !a.disabled).length;
  }

  currentAccountIdCached = undefined;

  async #currentAccountId() {
    if (this.currentAccountIdCached !== undefined) return this.currentAccountIdCached;
    let id = loadState().currentAccountId ?? null;
    if (!id) {
      const keychain = await keychainRead();
      const match = keychain?.refreshToken ? findCurrentAccount(keychain.refreshToken) : null;
      id = match?.id ?? null;
      mutateState((s) => { s.currentAccountId = id; });
    }
    this.currentAccountIdCached = id;
    return id;
  }

  /**
   * 请求前检查：当前号对该模型族已经被挡住（额度耗尽或冷却中）且有更好的候选时，先换。
   * 没有候选就继续用当前号；不空闲时不动，免得打断别的在途对话。
   */
  async #preflight(family) {
    if (this.rotating || !this.#idle()) return;
    const current = await this.#currentAccountId();
    if (!current) return;
    const state = loadState();
    if (!accountBlock(current, family, state).blocked) return;
    const next = pickNext(listAccounts(), state, { family, excludeId: current });
    if (!next) return;
    try {
      await this.#rotateTo(next, "preflight: current account is blocked");
    } catch (error) {
      log(`preflight rotate failed: ${error.message}`);
    }
  }

  /**
   * 成功后：清理封禁计数，并安排一次（限频）额度检查。当前号对这个模型族快耗尽且有候选时，
   * 在空闲时主动换号，不等擞墙。检查在后台进行，不延迟本次响应。
   */
  async #onSuccess(family) {
    const id = await this.#currentAccountId();
    if (!id) return;
    const state = loadState();
    if (state.banStrikes?.[id]) mutateState((s) => { delete s.banStrikes[id]; });
    if (this.autoSwitch) this.#scheduleQuotaCheck(family);
  }

  #scheduleQuotaCheck(family) {
    const wait = this.lastQuotaCheck + 60_000 - Date.now();
    if (wait > 0) {
      if (!this.quotaTimer) {
        this.quotaTimer = setTimeout(() => { this.quotaTimer = null; this.#scheduleQuotaCheck(family); }, wait + 50);
        this.quotaTimer.unref();
      }
      return;
    }
    if (this.quotaChecking) return;
    this.quotaChecking = true;
    this.lastQuotaCheck = Date.now();
    void (async () => {
      try {
        const id = await this.#currentAccountId();
        if (!id) return;
        const snapshot = await refreshQuota(id);
        const until = blockedUntil(snapshot, family, Date.now());
        if (until <= Date.now()) return;
        if (!this.#idle() || this.rotating || Date.now() - this.lastRotateAt < 120_000) return;
        const next = pickNext(listAccounts(), loadState(), { family, excludeId: id });
        if (!next) return;
        log(`quota low on current account for ${family} (until ${new Date(until).toISOString()}); moving to ${next.email}`);
        await this.#rotateTo(next, "proactive: quota low");
      } catch (error) {
        log(`quota check failed: ${error.message}`);
      } finally {
        this.quotaChecking = false;
      }
    })();
  }

  async #chatOnce(body, out, signal) {
    this.stats.requests += 1;
    const { family, effort } = this.resolveModel(String(body.model ?? ""), body.reasoning_effort);
    const { system, messages } = normalizeMessages(body.messages);
    if (!messages.length) throw new BridgeError("BAD_REQUEST", "messages must contain at least one non-system message");
    const tools = normalizeTools(body.tools);
    const toolsHash = sha1(JSON.stringify(tools));
    const sysHash = sha1(system);
    const fps = messages.map(fingerprint);
    const proc = await this.ensureReady();

    let conv;
    let mode;
    let input;
    const resumable = this.#findResume(messages);
    if (resumable) {
      conv = resumable;
      conv.busy = true;
      if (conv.sysHash === sysHash && conv.proc === proc && isPrefix(conv.fps, fps) && this.#deliver(conv, messages, proc)) {
        mode = "resume";
      } else {
        this.#dropTurn(conv, "The conversation history changed; the harness restarted this turn.");
        mode = "rebuild";
      }
    } else {
      const append = this.#findAppend(messages, fps, sysHash, toolsHash, proc);
      if (append) {
        conv = append.conv;
        conv.busy = true;
        mode = "append";
        input = append.rest;
      } else {
        conv = this.#slotForRebuild(fps, sysHash);
        conv.busy = true;
        mode = "rebuild";
      }
    }

    try {
      conv.lastUsed = Date.now();
      if (mode === "resume") {
        this.stats.resumes += 1;
      } else {
        if (mode === "rebuild") {
          if (conv.turn) this.#dropTurn(conv, "Superseded by a newer request.");
          this.#reset(conv);
          conv.sysHash = sysHash;
          conv.toolsHash = toolsHash;
          conv.tools = tools;
          conv.toolNames = new Set(tools.map((t) => t.name));
          await this.#open(conv, system, tools, proc);
          this.stats.rebuilds += 1;
        } else {
          this.stats.appends += 1;
        }
        await this.#select(conv, proc, family, effort);
        let blocks;
        if (mode === "rebuild") {
          let cut = messages.length;
          while (cut > 0 && (messages[cut - 1].role === "user" || messages[cut - 1].role === "system")) cut--;
          blocks = replayBlocks(messages.slice(0, cut), messages.slice(cut));
        } else {
          blocks = inputBlocks(input);
        }
        conv.turn = new Turn();
        conv.usageCursor = peekMaxStepIdx(this.#db(conv));
        this.#startPrompt(conv, proc, blocks);
      }
      log(`chat ${conv.tag} ${mode} model=${family}/${effort} msgs=${messages.length} tools=${tools.length}`);
      await this.#pump(conv, out, signal, fps);
    } catch (error) {
      conv.dirty = true;
      this.stats.errors += 1;
      throw error;
    } finally {
      conv.busy = false;
      conv.lastUsed = Date.now();
      if (!conv.sessionId && !conv.turn && this.convs.get(conv.key) === conv) this.convs.delete(conv.key);
    }
  }

  // ----- 会话匹配 -----

  #findResume(messages) {
    for (const conv of this.convs.values()) {
      const turn = conv.turn;
      if (conv.busy || !turn || turn.pending.size === 0) continue;
      if (messages.some((m) => m.role === "tool" && turn.pending.has(m.toolCallId))) return conv;
    }
    return undefined;
  }

  #findAppend(messages, fps, sysHash, toolsHash, proc) {
    let best;
    for (const conv of this.convs.values()) {
      if (conv.busy || conv.dirty || conv.turn || !conv.sessionId || conv.proc !== proc) continue;
      if (conv.sysHash !== sysHash || conv.toolsHash !== toolsHash) continue;
      if (!isPrefix(conv.fps, fps)) continue;
      const rest = messages.slice(conv.fps.length);
      if (!rest.length || !rest.every((m) => m.role === "user" || m.role === "system")) continue;
      if (!best || conv.fps.length > best.conv.fps.length) best = { conv, rest };
    }
    return best;
  }

  /** 只有在“明显是同一段对话”时才复用旧槽位（重试、改写末尾、出错后），否则另开，避免误杀并行的其他对话。 */
  #slotForRebuild(fps, sysHash) {
    let best;
    let bestLen = 0;
    for (const conv of this.convs.values()) {
      if (conv.busy || conv.sysHash !== sysHash) continue;
      const len = commonPrefix(conv.fps, fps);
      const sameThread = len >= 1 && (conv.dirty || conv.turn || len >= conv.fps.length - 2);
      if (sameThread && len > bestLen) { best = conv; bestLen = len; }
    }
    return best ?? this.#newConv();
  }

  #newConv() {
    while (this.convs.size >= this.cfg.maxLiveSessions) {
      const idle = [...this.convs.values()].filter((c) => !c.busy).sort((a, b) => (a.turn ? 1 : 0) - (b.turn ? 1 : 0) || a.lastUsed - b.lastUsed);
      const victim = idle[0];
      if (!victim) throw new BridgeError("CAPACITY", `All ${this.cfg.maxLiveSessions} Antigravity sessions are busy; retry shortly`);
      this.#dropTurn(victim, "Session evicted to make room for another conversation.");
      this.#reset(victim);
      this.convs.delete(victim.key);
    }
    const conv = {
      key: randomBytes(6).toString("hex"),
      tag: randomBytes(3).toString("hex"),
      sessionId: undefined,
      proc: undefined,
      tenantKey: undefined,
      tenantSecret: undefined,
      sysHash: undefined,
      toolsHash: undefined,
      tools: [],
      toolNames: new Set(),
      configOptions: [],
      fps: [],
      turn: undefined,
      dirty: false,
      busy: false,
      usageCursor: -1,
      lastUsed: Date.now(),
    };
    this.convs.set(conv.key, conv);
    return conv;
  }

  // ----- 会话生命周期 -----

  async #open(conv, system, tools, proc) {
    const attach = tools.length > 0;
    if (attach) {
      conv.tenantKey = randomBytes(16).toString("hex");
      conv.tenantSecret = randomBytes(24).toString("hex");
      this.tenants.set(conv.tenantKey, conv);
    }
    const mcpServers = attach
      ? [{ type: "http", name: MCP_SERVER, url: `${this.mcp.url}/${conv.tenantKey}`, headers: [{ name: "Authorization", value: `Bearer ${conv.tenantSecret}` }] }]
      : [];
    try {
      const r = await proc.newSession({
        cwd: this.workspace,
        mcpServers,
        _meta: { antigravity: { systemPrompt: { append: preamble(system, attach) } } },
      }, {
        onUpdate: (update) => {
          if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
            conv.configOptions = update.configOptions;
            this.#observe(update.configOptions);
          }
          conv.turn?.onUpdate(update);
        },
        onPermission: (request) => this.#permission(conv, request),
      }, 120_000);
      conv.sessionId = r.sessionId;
      conv.proc = proc;
      conv.configOptions = r.configOptions ?? [];
      this.#observe(r.configOptions, r.models?.availableModels);
    } catch (error) {
      this.#releaseTenant(conv);
      throw mapError(error);
    }
  }

  async #select(conv, proc, family, effort) {
    const sid = conv.sessionId;
    const modelOpt = conv.configOptions.find((o) => o.id === "model" || o.category === "model");
    if (modelOpt?.options && !modelOpt.options.some((o) => o.value === family)) {
      throw new BridgeError("UNKNOWN_MODEL", `Antigravity does not offer "${family}" to this account; available: ${modelOpt.options.map((o) => o.value).join(", ")}`);
    }
    try {
      if (modelOpt && modelOpt.currentValue !== family) {
        conv.configOptions = await proc.setConfigOption(sid, modelOpt.id, family);
      }
      if (FIXED_EFFORT.test(family)) return;
      const level = conv.configOptions.find((o) => o.id === "thought_level" || o.category === "thought_level");
      if (!level) return;
      const target = nearestEffort(effort, level.options?.map((o) => o.value));
      if (level.currentValue !== target) conv.configOptions = await proc.setConfigOption(sid, level.id, target);
    } catch (error) {
      throw mapError(error);
    }
  }

  #reset(conv) {
    if (conv.sessionId && conv.proc) void conv.proc.closeSession(conv.sessionId);
    this.#releaseTenant(conv);
    conv.sessionId = undefined;
    conv.proc = undefined;
    conv.configOptions = [];
    conv.fps = [];
    conv.turn = undefined;
    conv.dirty = false;
    conv.usageCursor = -1;
    conv.lastUsage = undefined;
  }

  #dropTurn(conv, reason) {
    const turn = conv.turn;
    if (!turn) return;
    if (!turn.finished && conv.sessionId) conv.proc?.cancel(conv.sessionId);
    turn.abandon(reason);
    conv.turn = undefined;
    conv.dirty = true;
  }

  #releaseTenant(conv) {
    if (conv.tenantKey) this.tenants.delete(conv.tenantKey);
    conv.tenantKey = undefined;
    conv.tenantSecret = undefined;
  }

  #db(conv) {
    return join(this.home, "agy", "conversations", `${conv.sessionId}.db`);
  }

  #sweep() {
    const now = Date.now();
    for (const conv of [...this.convs.values()]) {
      if (conv.busy) continue;
      const idleMs = now - conv.lastUsed;
      const ttl = conv.turn ? this.cfg.parkedTtlMs : this.cfg.idleTtlMs;
      if (idleMs > ttl) {
        this.#dropTurn(conv, "The harness never returned this tool result.");
        this.#reset(conv);
        this.convs.delete(conv.key);
        log(`session ${conv.tag} released after ${Math.round(idleMs / 60000)} min idle`);
      }
    }
  }

  // ----- 一轮生成 -----

  #startPrompt(conv, proc, blocks) {
    const turn = conv.turn;
    proc.prompt(conv.sessionId, blocks).then(
      (result) => turn.events.push({ kind: "done", result }),
      (error) => turn.events.push({ kind: "error", error }),
    );
  }

  /** 把宿主带回的工具结果回填给挂起的 MCP 调用；agent 已经自行结束本轮时，把结果作为新输入续上。 */
  #deliver(conv, messages, proc) {
    const turn = conv.turn;
    const results = new Map();
    let last = -1;
    messages.forEach((m, i) => {
      if (m.role === "tool" && turn.pending.has(m.toolCallId)) { results.set(m.toolCallId, m); last = Math.max(last, i); }
    });
    if (results.size !== turn.pending.size) return false;
    const extras = messages.slice(last + 1);
    if (extras.some((m) => m.role === "assistant" || m.role === "tool")) return false;
    const extraText = extras.length ? renderTranscript(extras.map((m) => ({ ...m, images: [] }))) : "";
    const extraImages = extras.flatMap((m) => m.images ?? []).filter((i) => i.data);
    const pending = [...turn.pending.values()];
    turn.pending.clear();

    if (turn.finished || !isTurnLive(turn)) {
      const transcript = pending.map((call) => renderMessage(results.get(call.id))).join("\n\n");
      conv.turn = new Turn();
      conv.usageCursor = peekMaxStepIdx(this.#db(conv));
      const blocks = [{ type: "text", text: `${transcript}${extraText ? `\n\n${extraText}` : ""}\n\nContinue the task with these tool results.` }];
      for (const img of extraImages) blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
      this.#startPrompt(conv, proc, blocks);
      return true;
    }
    pending.forEach((call, index) => {
      const m = results.get(call.id);
      const content = [{ type: "text", text: m.text.length ? m.text : "(no output)" }];
      for (const img of m.images) if (img.data) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      if (index === pending.length - 1) {
        if (extraText) content.push({ type: "text", text: `\n\n${extraText}` });
        // 宿主常把工具读到的图片放在随后的 user 消息里，挂回最后一个结果，模型才看得到
        for (const img of extraImages) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      call.result.resolve({ content });
    });
    return true;
  }

  async #stepUsage(conv) {
    if (!conv.sessionId) return undefined;
    const db = this.#db(conv);
    let batch = readStepsAfter(db, conv.usageCursor);
    for (let i = 0; !batch && i < 3; i++) {
      await delay(25);
      batch = readStepsAfter(db, conv.usageCursor);
    }
    // agy 把同一响应里的多个工具调用串行执行：后续调用之间没有新的模型步，沿用最近一次的上下文占用
    if (!batch) return conv.lastUsage ? { ...conv.lastUsage, completion: 0, reasoning: 0 } : undefined;
    conv.usageCursor = batch.maxIdx;
    const last = batch.last;
    // 上下文占用取最后一次模型调用的真实输入；输出取整段累计
    conv.lastUsage = {
      prompt: last.inputTokens + last.cachedReadTokens + last.cachedWriteTokens,
      cacheRead: last.cachedReadTokens,
      cacheWrite: last.cachedWriteTokens,
      completion: batch.sum.outputTokens,
      reasoning: batch.sum.thoughtTokens,
    };
    return conv.lastUsage;
  }

  async #pump(conv, out, signal, reqFps) {
    const turn = conv.turn;
    const proc = conv.proc;
    const sid = conv.sessionId;
    for (;;) {
      const ready = await turn.events.wait(signal, this.cfg.keepAliveMs);
      if (signal.aborted) {
        this.#dropTurn(conv, "The harness cancelled this request.");
        this.stats.aborts += 1;
        log(`chat ${conv.tag} aborted by client`);
        return;
      }
      if (!ready) { out.keepalive(); continue; }
      if (turn.events.peek()?.kind !== "text") {
        const held = turn.recoverNoticeHold();
        if (held) { turn.produced = true; out.emitText(held); }
      }
      const event = turn.events.shift();
      switch (event.kind) {
        case "thought": {
          const flush = turn.flushHeld();
          if (flush) { turn.produced = true; out.emitText(flush); }
          out.emitReasoning(event.text);
          break;
        }
        case "text": {
          const held = turn.absorb(event.text);
          if (held === "verdict") break; // 账号级通知，扣住等轮次结束判级
          if (held === "hold") break;
          const text = held?.flush ?? event.text;
          turn.produced = true;
          out.emitText(text);
          break;
        }
        case "park": {
          const flush = turn.flushHeld();
          if (flush) { turn.produced = true; out.emitText(flush); }
          turn.produced = true;
          const batch = [event.call];
          // 一次模型响应里的并行调用会在很短时间内相继到达，归并成同一步
          while (await turn.events.wait(signal, this.cfg.parkSettleMs)) {
            const next = turn.events.peek();
            if (next?.kind !== "park") break;
            turn.events.shift();
            batch.push(next.call);
          }
          batch.forEach((call, i) => { turn.pending.set(call.id, call); out.emitToolCall(i, call); });
          turn.toolSteps += 1;
          this.stats.toolCalls += batch.length;
          const usage = await this.#stepUsage(conv);
          conv.fps = [...reqFps, `a:${batch.map((c) => c.id).join(",")}`];
          out.finish("tool_calls", usage);
          return;
        }
        case "done": {
          const stop = event.result?.stopReason;
          // 输出全程被扣留且命中账号级文案：agy 把封禁/额度通知伪装成了正常回复
          if (turn.holding && turn.heldText && classifyNotice(turn.heldText)) {
            turn.finished = true;
            conv.turn = undefined;
            conv.dirty = true;
            throw new BridgeError("SERVER", turn.heldText.trim());
          }
          const flush = turn.flushHeld();
          if (flush) { turn.produced = true; out.emitText(flush); }
          if (stop === "max_tokens" && turn.continuations < this.cfg.maxContinuations) {
            turn.continuations += 1;
            proc.prompt(sid, [{ type: "text", text: CONTINUE_PROMPT }]).then(
              (result) => turn.events.push({ kind: "done", result }),
              (error) => turn.events.push({ kind: "error", error }),
            );
            break;
          }
          turn.finished = true;
          conv.turn = undefined;
          const usage = (await this.#stepUsage(conv)) ?? usageFromResult(event.result?.usage, turn.toolSteps + turn.continuations + 1);
          if (stop === "end_turn" && !turn.produced) {
            conv.dirty = true;
            throw new BridgeError("EMPTY", "Antigravity ended the turn without visible output");
          }
          if (stop !== "end_turn" && stop !== "max_tokens" && stop !== "refusal") {
            conv.dirty = true;
            throw new BridgeError("SERVER", `Antigravity stopped: ${stop}`);
          }
          conv.fps = [...reqFps, ...(out.hasText ? ["a:"] : [])];
          out.finish(stop === "end_turn" ? "stop" : stop === "max_tokens" ? "length" : "content_filter", usage);
          return;
        }
        case "error":
          turn.finished = true;
          conv.turn = undefined;
          conv.dirty = true;
          throw mapError(event.error);
        default:
          break;
      }
    }
  }

  // ----- MCP 侧 -----

  #authorize(tenant, token) {
    if (!tenant || !token) return false;
    const secret = this.tenants.get(tenant)?.tenantSecret;
    if (!secret) return false;
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(secret, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async #callTool({ tenantKey, name, args, signal }) {
    const conv = this.tenants.get(tenantKey);
    const turn = conv?.turn;
    const error = (text) => ({ content: [{ type: "text", text }], isError: true });
    if (!conv || !turn || turn.finished) return error("No harness turn is waiting for this tool call.");
    if (name === AWAIT_TOOL_NAME) {
      const call = turn.calls.get(String(args.call_id ?? ""));
      if (!call) return error(`Unknown harness call id ${String(args.call_id ?? "")}.`);
      turn.relaying = false;
      return this.#await(turn, call, signal);
    }
    let target = name;
    let targetArgs = args;
    if (name === CALL_TOOL_NAME) {
      target = String(args.name ?? "").trim();
      if (target.startsWith(PREFIX)) target = target.slice(PREFIX.length);
      targetArgs = isRecord(args.arguments) ? args.arguments : {};
    }
    if (!conv.toolNames.has(target)) return error(`The harness has no tool named ${target}.`);
    const call = turn.park(target, targetArgs);
    return this.#await(turn, call, signal);
  }

  /** agy 对单次 MCP 调用有 180 秒上限：超过 relayAfterMs 先回“仍在运行”，让 agent 调 await 接着等同一个结果 */
  async #await(turn, call, signal) {
    let timer;
    const relay = new Promise((resolve) => { timer = setTimeout(() => resolve("relay"), this.cfg.relayAfterMs); });
    const aborted = new Promise((resolve) => {
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    try {
      const outcome = await Promise.race([call.result.promise, relay, aborted]);
      if (outcome === "relay") {
        call.relays += 1;
        if (call.relays > this.cfg.maxRelays) {
          return { content: [{ type: "text", text: "The harness did not return this tool result in time. Stop now and end your turn, telling the user the tool timed out." }], isError: true };
        }
        turn.relaying = true;
        log(`relay ${call.id} (${call.name}) #${call.relays}: harness still running the tool`);
        return relayNotice(call);
      }
      if (outcome === "aborted") return { content: [{ type: "text", text: "The tool call was cancelled." }], isError: true };
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 只放行发往本桥 MCP、且是本会话声明过的工具；内层没有其它内置工具，
   * 但仍拒绝任何不能确认来源的请求。
   */
  #permission(conv, request) {
    const pick = (kind) => {
      const option = request.options?.find((o) => o.kind === kind);
      return option ? { outcome: "selected", optionId: option.optionId } : undefined;
    };
    const reject = (why) => {
      log(`permission refused (${why})`);
      return pick("reject_once") ?? { outcome: "cancelled" };
    };
    if (request.sessionId !== conv.sessionId) return reject("session mismatch");
    const tc = request.toolCall ?? {};
    const meta = isRecord(tc._meta) ? tc._meta : {};
    const server = tc.mcpServerName ?? meta.mcpServerName ?? meta.serverName ?? meta.server;
    const tool = tc.mcpToolName ?? meta.mcpToolName ?? meta.toolName ?? meta.tool;
    let name;
    if (server !== undefined || tool !== undefined) {
      if (server !== MCP_SERVER) return reject(`server ${server}`);
      name = tool;
    } else {
      const match = /^Run mcp_host_([A-Za-z0-9_.-]+)$/.exec(String(tc.title ?? ""));
      if (!match) return reject("not a harness tool");
      name = match[1];
    }
    if (!conv.toolNames.has(name) && name !== AWAIT_TOOL_NAME && name !== CALL_TOOL_NAME) return reject(`tool ${name} not offered`);
    return pick("allow_once") ?? { outcome: "cancelled" };
  }

  // ----- 诊断 -----

  health() {
    const state = loadState();
    const now = Date.now();
    const pool = listAccounts().map((a) => {
      const row = { name: a.name, current: a.id === state.currentAccountId, protected: (state.protected ?? []).includes(a.id) };
      for (const family of ["gemini", "thirdparty"]) {
        const b = accountBlock(a.id, family, state, now);
        if (b.blocked) (row.blocked ??= {})[family] = { reason: b.reason, minutes: Math.max(1, Math.round((b.until - now) / 60_000)) };
      }
      return row;
    });
    return {
      status: this.proc?.alive ? "ready" : "idle",
      pid: this.proc?.pid ?? null,
      autoSwitch: this.autoSwitch,
      switching: this.switching,
      account: state.currentAccountId ?? null,
      pool,
      exhausted: pool.filter((p) => p.blocked).map((p) => p.name),
      sessions: [...this.convs.values()].map((c) => ({
        tag: c.tag,
        busy: c.busy,
        parked: c.turn?.pending.size ?? 0,
        messages: c.fps.length,
        idleSeconds: Math.round((Date.now() - c.lastUsed) / 1000),
      })),
      stats: this.stats,
      models: this.catalog.families.map((f) => f.id),
    };
  }
}

function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileSync(path, content);
}


