/**
 * 降智（上游把 agy 的请求静默路由到弱模型）的启发式识别。
 *
 * 社区里反复观察到的特征：高思考档位却完全没有思考内容、解码速度明显高于正常
 * （整轮十几秒跑完）、以及同一会话的降智有粘滞性。这里只做告警与统计，不伪装客户端、
 * 不改上游请求——桥的立场是不做任何规避风控的事情。
 *
 * 打分而不是单一条件：模型有权决定不思考，单看“没有思考”误报太多。
 */
export const DEGRADE_THRESHOLD = 3;

/**
 * @param {object} input
 * @param {string} input.effort       本轮思考档位（low/medium/high）
 * @param {{completion?:number, reasoning?:number}} input.usage 本轮累计用量
 * @param {number} input.decodeMs     首段正文到结束的时长（毫秒），未知时传 0
 * @param {number} input.textChars    正文长度
 */
export function degradationSignals({ effort, usage, decodeMs = 0, textChars = 0 }) {
  const output = usage?.completion ?? 0;
  const thought = usage?.reasoning ?? 0;
  const signals = [];
  let score = 0;

  if (effort === "high" && thought === 0 && output >= 120) {
    signals.push("no_thinking");
    score += 2;
  }
  if (decodeMs > 0 && output >= 120) {
    const tps = output / (decodeMs / 1000);
    if (tps > 95) {
      signals.push("fast_decode");
      score += 2;
    }
  }
  if (effort === "high" && output > 0 && output < 60 && textChars < 400) {
    signals.push("short_output");
    score += 1;
  }
  return { score, signals, degraded: score >= DEGRADE_THRESHOLD };
}
