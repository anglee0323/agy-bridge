# agy-bridge

把本机已登录的 Google Antigravity CLI（`agy`）包成本地接口，同时说 OpenAI Chat Completions、Anthropic Messages 和 OpenAI Responses，让 Pi、Claude Code、Codex、Amp、Magpie 这类客户端直接使用 `agy` 里的模型。可选的多账号池会在额度耗尽时自动换号。

*A local OpenAI-, Anthropic- and Responses-compatible bridge over the official Antigravity CLI (`agy acp`). Tools run in your own harness; sessions are reused and resumed across requests; an optional account pool rotates on quota exhaustion.*

## 它做什么

- **harness 自己执行工具。** harness 的工具通过一个回环 MCP 服务暴露给 `agy`；模型要调用工具时，桥把调用挂起并以 OpenAI `tool_calls` 返回，harness 执行后带着结果再来，桥把结果回填到同一轮生成里。`agy` 内置的文件、终端工具全部关闭。
- **同一对话只发增量。** 按消息指纹把请求映射到已有会话：只多出用户新消息就只发增量；历史被改写、桥重启或换号后，用转录重放重建会话。
- **长耗时工具不超时。** 工具执行超过约 85 秒时先回"仍在运行"，让模型继续等待同一个结果，避开 `agy` 单次 MCP 调用 180 秒的上限。
- **OpenAI 兼容。** `/v1/chat/completions`（流式与非流式、`tools`、`reasoning_effort`、`stream_options.include_usage`）和 `/v1/models`，推理内容走 `reasoning_content`。
- **Anthropic 兼容。** `/v1/messages`（流式与非流式、`tools`、`thinking`）和 `/v1/messages/count_tokens`：思考、正文、`tool_use` 三种内容块，Claude Code 与 Magpie 可以直接接入。
- **Responses 兼容。** `/v1/responses`：`message` / `reasoning` / `function_call` / `custom_tool_call` 四种 output item，Codex CLI 的 freeform `apply_patch` 会按原样往返。
- **会话休眠与接回。** 会话 id 与指纹记在 `~/.cache/agy-bridge/sessions.json`（不存消息原文）。桥重启、空闲淘汰后，下一次请求用 ACP `session/resume` 接回原会话，而不是重放历史——重放会丢掉上游的 prompt cache。
- **工具常驻函数表。** 每个 MCP 工具带 `_meta.antigravity.alwaysLoad`，agy 不会把较大的工具改成按需加载。
- **降智告警。** 高思考档位却没有思考、解码速度异常时会记日志、计数，非流式响应带 `x-agy-degraded: 1`；可选让下一轮重建会话。
- **账号池（可选）。** 按模型族读额度、冷却到真实重置时间、空闲时主动换号，被封的号按退避间隔复测。
- **只监听回环地址。** 校验 Host、拒绝带 Origin 的浏览器请求，可选 Bearer 令牌。

## 环境要求

- macOS。账号切换依赖 macOS 钥匙串；其它系统未测试。
- Node.js 22.13 及以上（用到不再需要实验开关的 `node:sqlite`），无其它依赖。
- 已安装 `agy` 并至少用 `agy` 登录过一次。
- 只在 [Pi](https://github.com/earendil-works/pi) 上测试过，其它 harness 理论上可用，但没有验证。

## 快速开始

```bash
git clone https://github.com/anglee0323/agy-bridge.git
cd agy-bridge
node bin/agy-bridge.mjs
```

看到 `agy-bridge listening on http://127.0.0.1:8789/v1` 即可。检查状态：

```bash
curl -s http://127.0.0.1:8789/health
curl -s http://127.0.0.1:8789/v1/models
curl -s http://127.0.0.1:8789/metrics        # Prometheus 文本格式
```

模型列表以 `/v1/models` 为准，来自 `agy` 当前账号可用的模型。模型 id 可以带强度后缀（如 `gemini-3.8-flash-high`），也可以用请求里的 `reasoning_effort`（`low`、`medium`、`high`）。

### 接入 Pi

在 `~/.pi/agent/models.json` 的 `providers` 里加入：

```json
"antigravity": {
  "name": "Antigravity",
  "baseUrl": "http://127.0.0.1:8789/v1",
  "api": "openai-completions",
  "apiKey": "local",
  "models": [
    {
      "id": "gemini-3.8-flash",
      "name": "Gemini 3.8 Flash",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "maxTokensField": "max_tokens"
      },
      "contextWindow": 256000,
      "maxTokens": 65536,
      "thinkingLevelMap": { "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": null, "max": null }
    }
  ]
}
```

其它 harness 填 Base URL `http://127.0.0.1:8789/v1`，API key 任意（设置了 `AGY_BRIDGE_TOKEN` 时填该令牌）。

### 接入 Claude Code / Anthropic 客户端

桥同时提供 Anthropic Messages 接口，把客户端指过来即可，不需要插件：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8789
export ANTHROPIC_AUTH_TOKEN=local     # 设置了 AGY_BRIDGE_TOKEN 时填该令牌
export ANTHROPIC_MODEL=gemini-3.8-flash
claude
```

客户端自带的模型名（`claude-sonnet-4-5` 之类）桥不认识时，会落到 `AGY_BRIDGE_FALLBACK_MODEL`，没设置就用模型目录里的第一个模型；也可以用 `/v1/models` 里的任意 id（含 `-high` / `-medium` / `-low` 后缀）。`max_tokens`、`temperature`、`stop` 这些采样参数在 ACP 上没有对应项，会被忽略。

### 接入 Codex CLI

Codex 从 2026 年 2 月起只支持 Responses 协议（`wire_api = "chat"` 已删除），桥现在直接提供 `/v1/responses`：

```toml
# ~/.codex/config.toml
model = "gemini-3.8-flash"
model_provider = "agy-bridge"

[model_providers.agy-bridge]
name = "agy-bridge"
base_url = "http://127.0.0.1:8789/v1"
env_key = "AGY_BRIDGE_API_KEY"   # 没设 AGY_BRIDGE_TOKEN 时随便填一个值
wire_api = "responses"
```

```bash
export AGY_BRIDGE_API_KEY=local
codex
```

Codex 的 `apply_patch` 是 freeform 的 `type: "custom"` 工具：桥在模型侧把它呈现成单字符串参数的函数，回来时还原成 `custom_tool_call`，补丁原文不会被包进 JSON。Codex 会按模型名决定用不用这个工具，用 `gemini-*` 这类它不认识的模型名时通常退回 `exec_command` 改文件，两条路都能走通。`web_search`、`local_shell` 这类内置工具桥不实现，会被跳过。

本机也可以只加一个 profile，不动默认配置：`~/.codex/agy.config.toml` 里写 `model` + `model_provider = "agy-bridge"`，然后 `codex -p agy`。

### 接入 Magpie

Magpie 的 provider 插件说 Anthropic Messages，所以可以直接把桥当成一个 provider：

```bash
# Magpie 里新增自定义 provider（OpenAI 或 Anthropic 格式都行）
# Base URL: http://127.0.0.1:8789
# 模型：gemini-3.8-flash / claude-sonnet-4-6 / gpt-oss-120b-medium
```

社区里的 `@magpie-community/opencode-agy-cli-auth` 插件把 agy 直接拉进 Magpie 进程；本桥的差别是 agy 只跑在一个独立进程里，Magpie 重启不影响会话，账号池与额度冷却也由桥统一管理。

### 开机常驻（macOS）

```bash
sed -e "s|__NODE__|$(command -v node)|" -e "s|__REPO__|$PWD|" -e "s|__HOME__|$HOME|" \
  docs/launchd.example.plist > ~/Library/LaunchAgents/local.agy-bridge.plist
launchctl load ~/Library/LaunchAgents/local.agy-bridge.plist
```

进程名显示为 `agy-bridge`，崩溃自动拉起，日志在 `~/.agy-bridge/bridge.log`。

## 账号池

默认只使用 `agy` 当前登录的账号。要用多个账号，先把它们放进桥自己的金库：

```bash
node bin/agy-bridge.mjs import-current        # 收入当前登录的账号
node bin/agy-bridge.mjs add-account           # 浏览器登录并收入新账号（不影响当前登录）
node bin/agy-bridge.mjs accounts              # 查看金库、冷却、保护状态
node bin/agy-bridge.mjs quota                 # 读取各号额度
```

金库在 `~/.agy-bridge/vault/`，是明文 JSON（目录 0700、文件 0600），保护级别与 `agy` 自己的会话文件相同，没有额外加密。

### 选号与冷却

- 额度按模型族独立记账：Gemini 与 Claude/GPT-OSS 各有自己的 5 小时窗口和周窗口。
- 读额度用官方 `agy -p /usage --output-format json`，在每个账号自己的私有 HOME（`~/.agy-bridge/homes/<id>`）里运行：不跑模型，不动全局钥匙串，所以能读任意账号，也不影响正在服务的号。
- 5 小时窗口剩余低于 15%、周窗口剩余不高于 1% 视为耗尽，冷却到真实重置时间。
- 优先用周额度最先重置的号，同分取最久未用。
- 请求前发现当前号已被挡住且有候选，先换；请求后（每分钟最多一次）发现快耗尽且有候选，在空闲时主动换。有对话在途时不主动换。
- `/usage` 不反映封禁：被封的号仍显示 100%，只能靠实际请求发现。被封的号按 2、4、8、16 小时、封顶 24 小时的间隔复测，成功后清零。
- 刷新令牌失效的候选号会被标记并跳过。
- 默认最多 2 个活会话（`AGY_BRIDGE_MAX_SESSIONS`）。
- 切号会改写钥匙串里的登录条目，所以同一时刻整台机器只有一个账号在线；切号前自动备份，保留最近 8 份。

## 命令

```
serve                                 启动服务（默认，可省略）
accounts / whoami                     查看金库、当前登录号、各号冷却状态
quota [--cached] [--all]              读取各号额度（不跑模型、不切号）
reset-cooldowns [account]             清除冷却，号解封后立刻回池
import-current [name]                 把当前登录的账号收入金库
add-account [--no-browser]            浏览器 OAuth 登录新账号
remove <id|email|name>                从金库移除账号（含其私有 HOME）
protect / unprotect <id|email|name>   保护账号：永不自动切入
switch <id|email|name> [--dry-run]    手动切号，先刷新令牌，失败则零写入
backup [note] / backups / restore <stamp>   凭据备份与恢复
migrate-from-agy-switch               一次性从 agy-switch 的数据目录导入账号
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AGY_BRIDGE_PORT` | `8789` | 监听端口（始终绑定 127.0.0.1） |
| `AGY_BRIDGE_TOKEN` | 无 | 设置后所有请求需带 `Authorization: Bearer <token>` |
| `AGY_BRIDGE_AUTO_SWITCH` | 开 | 设为 `0` 关闭自动换号 |
| `AGY_BRIDGE_MAX_SESSIONS` | `2` | 同时存活的会话数上限 |
| `AGY_BRIDGE_DEFAULT_EFFORT` | `high` | 请求未指定时的推理强度 |
| `AGY_BRIDGE_RELAY_AFTER_MS` | `85000` | 工具执行多久后先回"仍在运行" |
| `AGY_BRIDGE_IDLE_TTL_MS` / `AGY_BRIDGE_PARKED_TTL_MS` | 15 / 10 分钟 | 空闲会话与挂起会话的释放时间 |
| `AGY_BRIDGE_MCP_PORT` | `AGY_BRIDGE_PORT + 1` | 回环 MCP 端口；固定端口被占用时自动退回随机端口（此时带工具的休眠会话不再接回） |
| `AGY_BRIDGE_FALLBACK_MODEL` | 模型目录第一个 | 客户端自带的模型名（`claude-*`、`gpt-5*`）认不出来时用的模型；旧名 `AGY_BRIDGE_ANTHROPIC_MODEL` 仍可用 |
| `AGY_BRIDGE_DEGRADE_ROLLOVER` | 关 | 设为 `1` 时，疑似降智的轮次结束后下一轮重建会话 |
| `AGY_BRIDGE_VAULT` / `AGY_BRIDGE_HOMES` / `AGY_BRIDGE_HOME` | 见下 | 金库、私有 HOME 根目录、桥的隔离 agy 数据目录 |
| `AGY_BIN` | 自动查找 | `agy` 二进制路径 |
| `AGY_OAUTH_CLIENT_ID` / `AGY_OAUTH_CLIENT_SECRET` | 自动识别 | 手动指定 OAuth 客户端，两个都设置才生效 |

OAuth 客户端凭据不放在本仓库：运行时从你本机的 `agy` 二进制里读取。client id 取自 `agy` 登录令牌的 `aud` 字段，secret 在二进制里的候选中用一次假令牌探测确认，结果缓存到 `~/.cache/agy-bridge/oauth-client.json`（`agy` 升级后自动重新识别）。所以需要先用 `agy` 登录过一次；识别失败时用上面两个环境变量手动指定。

数据位置：`~/.agy-bridge/`（金库、私有 HOME、日志），`~/.cache/agy-bridge/`（运行状态 `state.json`、备份、隔离的 agy 数据目录）。备份目录里含有凭据，权限为 0700。

## 已知限制

- 上下文窗口是官方的 256K，没有任何补丁。
- ACP 不支持采样参数：`temperature`、`stop`、`max_tokens` 会被忽略。
- 内层 `agy` 有自己的系统提示词，桥只能在后面追加，不能替换。
- `agy` 把同一响应里的多个工具调用串行执行，每个调用各占一次 harness 往返。
- 换号会重启 `agy acp`：会话尽量用 `session/resume` 接回，接不上才重放历史（最多最近约 160KB）。
- 降智检测是启发式：模型有权决定不思考，所以只在多个信号同时出现时才告警，仍可能有误报。
- Anthropic 侧返回的思考块 `signature` 为空；客户端把它回传时桥会忽略。
- 接回休眠会话后的第一轮，agy 可能先看到一次过期的工具表（模型报一次 “undefined tool” 后自行重试）；工具调用本身是通的。
- Responses 侧不实现 `previous_response_id` 的服务端状态：Codex 默认每轮发全量 `input`，桥按指纹续接；只发增量又带 `previous_response_id` 的客户端会拿不到历史。
- Responses 的内置工具（`web_search`、`local_shell`、`file_search` 等）不实现，会被跳过；`custom` 工具按单字符串参数呈现。
- 只在 macOS 与 `agy` 1.5.x 上测试。

## 工作原理

```
harness ──OpenAI──▶ agy-bridge ──ACP(stdio)──▶ agy acp ──▶ Antigravity
   ▲                    │  ▲
   └── tool_calls ──────┘  └── 回环 MCP：agy 调工具 → 挂起 → harness 执行 → 回填
```

内层 `agy` 运行一个关闭全部内置工具的 agent，只能通过桥注入的 MCP 工具行动。

| 文件 | 职责 |
|---|---|
| `bin/agy-bridge.mjs` | 命令行入口与子命令 |
| `bin/serve.mjs` | HTTP 服务、回环与 Origin 防护 |
| `lib/runtime.mjs` | 会话路由（resume / append / rebuild）、挂起回填、轮次泵、换号编排 |
| `lib/pool.mjs` | 额度判定、冷却、选号、错误分类（纯函数，有单测） |
| `lib/state.mjs` | 运行状态读写，守护进程与命令行共用，每次现读、原子写 |
| `lib/quota.mjs` / `lib/homes.mjs` | `/usage` 解析、私有 HOME 与额度刷新 |
| `lib/switcher.mjs` / `lib/credstore.mjs` | 切号编排、钥匙串与会话文件、备份恢复 |
| `lib/oauth.mjs` / `lib/oauth-client.mjs` / `lib/login.mjs` / `lib/vault.mjs` | 令牌刷新、OAuth 客户端识别、浏览器登录、账号金库 |
| `lib/acp.mjs` / `lib/mcp.mjs` | `agy acp` 的 JSON-RPC 链路、回环 MCP 服务 |
| `lib/transcript.mjs` / `lib/output.mjs` | 消息归一化与历史重放、OpenAI 响应输出 |
| `lib/anthropic.mjs` | Anthropic 请求翻译与 SSE 内容块输出 |
| `lib/responses.mjs` | Responses 请求翻译、freeform 工具与 SSE 事件输出 |
| `lib/sessions.mjs` | 休眠会话账本（会话 id + 指纹，不存原文） |
| `lib/degrade.mjs` / `lib/metrics.mjs` | 降智启发式、Prometheus 导出 |

实测得到的 `agy` 行为记录在 [docs/antigravity-notes.md](docs/antigravity-notes.md)。

## 开发与测试

```bash
npm test                  # 单元测试，不需要登录、不联网
node tests-e2e.mjs        # 端到端，需要服务在运行、有可用账号，会消耗少量额度
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
