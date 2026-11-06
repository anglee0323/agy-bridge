# agy-bridge

个人自用工具。把本机已登录的 Antigravity CLI（`agy acp`）包成 OpenAI 兼容接口（默认 `127.0.0.1:8789/v1`），任意 harness 接入即用：

- 工具调用由 harness 自己执行（MCP 挂起回填，agent 只负责推理）
- 同一对话自动续接，只发增量；桥重启后重放历史恢复
- 长耗时工具有中继保活，不会撞 agy 的 MCP 超时
- 多账号金库 + 轮次边界自动切号（规划中）
- 只监听回环地址，凭据始终留在官方 agy 进程里，桥不代理、不外发

## 风险声明（写给未来的自己）

Google Antigravity 补充条款明确禁止把 agy 包进第三方 coding agent、以及自动化账号轮换，违规可能封号。本工具是明知条款的自用选择：不开源、不分发、不教唆；多个账号可能被同批处置，随时准备接受后果。

## 用法

```bash
bin/agy-bridge.mjs            # 前台启动
curl -s localhost:8789/health # 状态
```

harness 侧：任意支持自定义 OpenAI base URL 的工具，指向 `http://127.0.0.1:8789/v1`，API key 随意填，模型名即 `gemini-3.8-flash` / `claude-sonnet-4-6` / `claude-opus-4-6-thinking`。

环境变量：`AGY_BRIDGE_PORT`、`AGY_BRIDGE_TOKEN`、`AGY_BRIDGE_HOME`、`AGY_BRIDGE_DEFAULT_EFFORT`、`AGY_BRIDGE_MAX_SESSIONS` 等。

## 结构

| 文件 | 职责 |
|---|---|
| `bin/agy-bridge.mjs` | HTTP 路由、回环/Origin 防护、配置 |
| `lib/runtime.mjs` | 会话路由（resume/append/rebuild）、挂起回填、轮次泵、权限 |
| `lib/acp.mjs` | `agy acp` 进程与 NDJSON JSON-RPC |
| `lib/mcp.mjs` | 回环 Streamable HTTP MCP，tools/call 以 SSE 挂起 |
| `lib/transcript.mjs` | 消息归一化、指纹、历史重放、工具声明压缩 |
| `lib/output.mjs` | OpenAI 流式/非流式写出 |
| `lib/usage-db.mjs` | 读 agy 会话库的逐步用量 |
| `tests-e2e.mjs` | 端到端（真实 agy，消耗少量额度） |
| `docs/antigravity-notes.md` | 实测得到的 agy 行为备忘 |

## 路线

1. 账号金库 + 切号执行（从 agy-switch 移植 account_service，主号备份先行，过期号当哑巴负载验证）
2. 轮次边界额度判断 → 自动切号 → 会话重建重放
3. `accounts add` 浏览器 OAuth 登录
4. launchd 常驻 + Pi provider 配置
