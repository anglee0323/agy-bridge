# Antigravity (agy) 实测行为备忘

把本机已登录的 `agy acp` 包成 OpenAI 兼容接口（`127.0.0.1:8789/v1`），工具由调用方 harness 执行。
这是验证用的 Node 原型，确认可行后移植为 agy-switch 仓库里的第二个二进制。

```
node --no-warnings server.mjs          # 启动
node test-e2e.mjs                      # 端到端（真实 agy，少量额度，不切号）
pi -e ./pi-provider.ts --model antigravity/gemini-3.8-flash
```

## 结构

| 文件 | 职责 |
|---|---|
| `server.mjs` | HTTP 路由、回环/Origin/Content-Type 防护、配置 |
| `lib/runtime.mjs` | 会话路由（resume / append / rebuild）、挂起回填、轮次泵、权限、中继 |
| `lib/acp.mjs` | `agy acp` 进程与 NDJSON JSON-RPC |
| `lib/mcp.mjs` | 回环 Streamable HTTP MCP，tools/call 以 SSE 挂起 |
| `lib/transcript.mjs` | 消息归一化、指纹、历史重放、工具声明压缩 |
| `lib/output.mjs` | OpenAI 流式 / 非流式写出，延迟提交响应头 |
| `lib/usage-db.mjs` | 读 agy 会话库的逐步用量 |

## 实测得到的 agy 行为（2026-11-06，本机 agy）

- 登录态是 macOS 用户级的：`--gemini-dir`、`--app-data-dir` 只隔离数据，不隔离账号；换 HOME 则 `Authentication required`。切号只能在轮次之间做，切完要重建会话。
- `--app-data-dir` 必须是相对路径（相对 gemini-dir），绝对路径会让 language server 启动失败。
- 如实的 `clientInfo.name`（`agy-bridge`）就能看到 Claude / GPT-OSS，不需要伪造 JetBrains 白名单标识。
- 插件 agent（`tools: []` + `excludeDefaultComponents: true` + `mainAgent: true`）生效后，内层只剩注入的 MCP 工具加 `list_resources` / `read_resource` / `manage_task`。
- `toolPermission: request-review` 下，调用注入的 MCP 工具不会触发 `session/request_permission`。
- MCP 工具名对 agent 呈现为 `mcp_<server>_<tool>`；`tools/call` 的 `_meta` 带 `antigravity.google/conversation_id` 与 `progressToken`。
- 同一响应里的多个工具调用会被 agy 串行执行：第二个 `tools/call` 要等第一个返回后才发出，所以每个调用各占一次 harness 往返，期间没有新的模型步。
- `session/prompt` 结果带整轮 usage（`inputTokens` 不含缓存命中）；逐步用量在 `<gemini-dir>/agy/conversations/<sessionId>.db` 的 `steps` 表。
- 模型目录：`model` 配置项的值是模型族（`gemini-3.8-flash`、`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`），思考强度是独立的 `thought_level`（low / medium / high）。
- 内存：前台进程约 52MB，每个活会话一个 worker 约 90–140MB，桥本身约 51MB。

## 已验证

纯文本流式、跨进程续接走增量、工具挂起回填（Pi 的 read / bash / edit 全由 Pi 执行）、非流式、客户端中断取消上游、桥重启后历史重放、Claude 工具调用、长耗时工具中继保活、错误码映射、跨站与非 JSON 请求拦截。

## 未做（移植阶段）

- 额度耗尽时自动换号（接 agy-switch 的 `switch_account` / 额度 / 排序），以及和桌面端智能切号的活跃会话协调
- launchd 常驻、设置页开关、中英文案
- 未打补丁时单条输入 192KB 截断：重建会话时只能重放最近约 160KB 历史

## 2026-11-07 补充实测

- `agy -p /usage --output-format json` 不跑模型（num_turns=0，不建会话）。结构：`command.data.groups[]` = `{name, buckets[]}`，bucket = `{id, window: "5h"|"weekly", remaining_fraction, reset_time}`；分组 "Gemini Models" 与 "Claude and GPT models"，各自独立的 5 小时与周窗口。未使用的号显示 100%，重置时间为查询时刻起算。
- **`/usage` 不反映封禁**：被封号的账号仍显示 100%，封禁只在真正发起模型请求时以“通知伪装成正常回复”的形式出现。
- **私有 HOME 隔离可行**：把 `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token` 写好，以该目录为 HOME 运行 agy，它就用这份凭据（过期的 access_token 会用 refresh_token 自行刷新并写回该文件）；空 HOME 则报 Authentication required。全程系统钥匙串条目指纹不变。推断原因：钥匙串位置随 HOME 变化，agy 找不到后回落到文件凭据。
- agy 二进制里有 `AGY_ACCOUNT`、`AGY_ADC_AUTH`、`ANTIGRAVITY_CONFIG_REL_DIR` 等环境变量，用途未验证；私有 HOME 已足够，没有必要再探。
- `agy -p` 会顺带拉起常驻的 `agy --hub` 进程，读完额度要把本次新增的 hub 收掉。
- 社区项目 zacbemis/pi-antigravity-acp-provider 用的 AGY_ACP_FORCE_FILE_STORAGE 是它自带运行时的开关，agy 本体里没有这个变量。

## 2026-11-12 补充实测（agy 1.5.5）

- `initialize` 的 `agentCapabilities`：`loadSession: true`、`sessionCapabilities: {resume, close, load, list, additionalDirectories}`、`mcpCapabilities: {http: true}`、`_meta.antigravity: {tier: true, systemPrompt: {append: true}}`。所以会话接回、会话列表、HTTP MCP 都是官方能力，不需要模拟编辑器。
- `session/resume` 只认 `{sessionId}`；`session/close` 之后仍然可以 resume（返回 `{sessionId, models, modes, configOptions, _meta}`），所以“关闭会话释放 worker”和“之后接回”可以同时成立。多传的参数（如 `mcpServers`）不会被拒绝，但响应里不回显，是否生效没有可观测证据。
- resume 后的**第一轮** prompt 可能看到过期的工具表：模型会先报一次 “undefined tool”，agy 内部重试后同一轮就能正常调用。工具调用本身是通的（桥的 MCP 端点与 tenant 需要先注册好）。
- `tools/list` 里每个工具带 `_meta: {"antigravity": {"alwaysLoad": true}}` 时，agy 不会把较大的工具改成按需加载（社区实测，agy#989）。桥仍然会把工具声明压到 ~1.35KB 以内，两条一起用。
- prompt cache 的稳定窗口约 5 分钟，前缀（系统提示 + 工具表 + 历史）一变就掉；重放历史等于主动放弃缓存，所以桥优先 `session/resume`，接不上才重放。
- 降智（上游静默路由到弱模型）在社区里反复出现：agy CLI 的算力池小于桌面端，且同一会话有粘滞性。可观测特征是高思考档位没有思考内容、解码速度异常高；桥据此打分告警，不做任何客户端伪装。
- Anthropic 侧实测：`tool_use` 挂起 → 客户端回 `tool_result` → 同一轮续写正常；`usage.input_tokens` 取自会话库 `steps` 表（不含缓存读写），与 OpenAI 侧同源。
