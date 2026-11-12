/**
 * Prometheus 文本格式导出。只暴露桥自己已经维护的计数与状态，额外开销可以忽略，
 * 也不引入任何依赖；抓取端点与 /health 同源。
 */

const COUNTERS = [
  ["agy_bridge_requests_total", "Chat requests accepted", "requests"],
  ["agy_bridge_rebuilds_total", "Requests that had to open a new Antigravity session", "rebuilds"],
  ["agy_bridge_appends_total", "Requests that only sent the new messages to a live session", "appends"],
  ["agy_bridge_resumes_total", "Requests that resumed a parked tool call", "resumes"],
  ["agy_bridge_reconnects_total", "Requests that resumed a hibernated Antigravity session", "reconnects"],
  ["agy_bridge_tool_calls_total", "Harness tool calls parked for the harness to run", "toolCalls"],
  ["agy_bridge_errors_total", "Requests that ended in an error", "errors"],
  ["agy_bridge_aborts_total", "Requests cancelled by the client", "aborts"],
  ["agy_bridge_degraded_turns_total", "Turns that looked like an upstream degraded-model fallback", "degradedTurns"],
];

const escape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function metric(lines, name, help, type, samples) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [labels, value] of samples) {
    const suffix = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`).join(",")}}` : "";
    lines.push(`${name}${suffix} ${value}`);
  }
}

export function prometheus(health) {
  const lines = [];
  const stats = health.stats ?? {};
  const sessions = health.sessions ?? [];
  const pool = health.pool ?? [];

  metric(lines, "agy_bridge_up", "1 when the Antigravity ACP process is running", "gauge", [[null, health.status === "ready" ? 1 : 0]]);
  metric(lines, "agy_bridge_auto_switch", "1 when the account pool may rotate accounts", "gauge", [[null, health.autoSwitch ? 1 : 0]]);
  for (const [name, help, key] of COUNTERS) {
    metric(lines, name, help, "counter", [[null, stats[key] ?? 0]]);
  }
  metric(lines, "agy_bridge_sessions", "Live Antigravity sessions", "gauge", [[null, sessions.length]]);
  metric(lines, "agy_bridge_sessions_busy", "Live sessions with a request in flight", "gauge", [[null, sessions.filter((s) => s.busy).length]]);
  metric(lines, "agy_bridge_accounts", "Accounts in the vault", "gauge", [[null, pool.length]]);
  metric(lines, "agy_bridge_accounts_blocked", "Accounts currently cooling down for any model family", "gauge", [[null, pool.filter((a) => a.blocked).length]]);
  metric(lines, "agy_bridge_models", "Models the current account offers", "gauge", [[null, (health.models ?? []).length]]);
  if (health.degraded?.signals && typeof health.degraded.signals === "object") {
    for (const [signal, count] of Object.entries(health.degraded.signals)) {
      metric(lines, "agy_bridge_degrade_signals_total", "Degradation signals seen per kind", "counter", [[{ signal }, count]]);
    }
  }
  return `${lines.join("\n")}\n`;
}
