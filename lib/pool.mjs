/**
 * 账号池的纯函数：额度判定、冷却、挑号。没有 I/O，便于单测。
 *
 * 模型族（额度是按族独立记的）：
 *   gemini      Gemini 模型
 *   thirdparty  Claude 与 GPT-OSS
 *
 * 额度快照 Snapshot：
 *   { at, gemini: { fiveHour: {remaining, resetAt}, weekly: {...} }, thirdparty: {...} }
 *   remaining 为 0~1 的剩余比例，resetAt 为毫秒时间戳。
 */

/** 5 小时窗口剩余低于该比例视为耗尽（给在途请求留余量）。 */
export const FIVE_HOUR_BLOCK_BELOW = 0.15;
/** 周窗口剩余不高于该比例视为耗尽（精度 1%）。 */
export const WEEKLY_BLOCK_AT_OR_BELOW = 0.01;

const HOUR = 3600_000;

export function familyOf(modelId) {
  return /^gemini/i.test(String(modelId)) ? "gemini" : "thirdparty";
}

/** 模型族在该快照下被额度挡到何时；0 表示没被挡。已过重置时间的窗口视为已恢复。 */
export function blockedUntil(snapshot, family, now = Date.now()) {
  const f = snapshot?.[family];
  if (!f) return 0;
  let until = 0;
  if (f.fiveHour && f.fiveHour.remaining < FIVE_HOUR_BLOCK_BELOW && f.fiveHour.resetAt > now) {
    until = Math.max(until, f.fiveHour.resetAt);
  }
  if (f.weekly && f.weekly.remaining <= WEEKLY_BLOCK_AT_OR_BELOW && f.weekly.resetAt > now) {
    until = Math.max(until, f.weekly.resetAt);
  }
  return until;
}

/** 被封后的复测间隔：2h、4h、8h、16h，封顶 24h；复测成功后次数清零。 */
export function banCooldownMs(strikes) {
  const n = Math.max(1, strikes | 0);
  return Math.min(24 * HOUR, 2 * HOUR * 2 ** (n - 1));
}

/** 某账号对某模型族现在能不能用，以及不能用的原因。 */
export function accountBlock(id, family, state, now = Date.now()) {
  const cd = state.cooldowns?.[id];
  if (cd && cd.until > now) return { blocked: true, until: cd.until, reason: cd.reason ?? "cooldown" };
  const fam = state.familyCooldowns?.[id]?.[family] ?? 0;
  if (fam > now) return { blocked: true, until: fam, reason: "quota" };
  const q = blockedUntil(state.quota?.[id], family, now);
  if (q > now) return { blocked: true, until: q, reason: "quota" };
  return { blocked: false, until: 0, reason: null };
}

/** 该族周窗口的重置时间；未知返回 Infinity（排在已知的后面）。 */
function weeklyResetAt(snapshot, family) {
  return snapshot?.[family]?.weekly?.resetAt ?? Infinity;
}

/**
 * 挑下一个账号：跳过停用、受保护、被排除、被挡住的；
 * 优先周额度最先重置的（用掉快过期的额度），同分取最久没用的。
 */
export function pickNext(accounts, state, { family, excludeId = null, now = Date.now() }) {
  const protectedIds = new Set(state.protected ?? []);
  return accounts
    .filter((a) => !a.disabled && !protectedIds.has(a.id) && a.id !== excludeId && !accountBlock(a.id, family, state, now).blocked)
    .sort((a, b) => {
      const wa = weeklyResetAt(state.quota?.[a.id], family);
      const wb = weeklyResetAt(state.quota?.[b.id], family);
      if (wa !== wb) return wa < wb ? -1 : 1;
      return (a.lastUsed ?? 0) - (b.lastUsed ?? 0);
    })[0] ?? null;
}

/** 账号级错误分类（用于抛出的错误）：banned 被封；quota 额度耗尽；rate 短暂限流；auth 登录缺失/失效。 */
export function classifyAccountError(message) {
  const text = String(message);
  if (/violation of (the )?Terms of Service|service has been disabled in this account/i.test(text)) return "banned";
  if (/RESOURCE_EXHAUSTED|exhausted your quota|exceeded your (model )?(quota|limit)/i.test(text)) return "quota";
  if (/\(code 429\)|too many requests|rate.?limit/i.test(text)) return "rate";
  if (/Authentication required|UNAUTHENTICATED|invalid authentication credentials|not logged in|No credential/i.test(text)) return "auth";
  return null;
}

/**
 * 模型“正文”里的通知识别：agy 会把封禁/额度通知包装成正常回复。
 * 比 classifyAccountError 严格得多，避免把正常讨论配额、429 的回答误判成账号错误：
 * 只认短文本（<400 字），且封禁文案或以通知口吻开头的额度文案。
 */
export function classifyNotice(text) {
  const t = String(text).trim();
  if (!t || t.length > 400) return null;
  if (/violation of (the )?Terms of Service|service has been disabled in this account/i.test(t)) return "banned";
  if (/^(\u26a0\ufe0f?|error:?|warning:?)?\s*(you have )?exhausted your quota|^(\u26a0\ufe0f?|error:?)?\s*RESOURCE_EXHAUSTED/i.test(t)) return "quota";
  return null;
}
