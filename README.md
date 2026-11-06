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

其它子命令：

```
accounts / whoami                     查看金库与当前登录号
migrate-from-agy-switch               一次性把 ~/.antigravity_tools 账号迁入桥自己的金库
protect / unprotect <id|email|name>   保护账号：永不自动切入（主号用）
add-account [--no-browser]            浏览器 OAuth 登录新号入金库
backup [note] / backups / restore     凭据备份与恢复
switch <id|email> [--dry-run]         手动切号（先刷新，失败零写入）
```

数据位置：`~/.agy-bridge/vault/` 是桥自己的账号金库（与 agy-switch 完全解耦，删它不影响本桥）；`~/.cache/agy-bridge/` 放运行数据、备份与 state.json。

环境变量：`AGY_BRIDGE_PORT`、`AGY_BRIDGE_TOKEN`、`AGY_BRIDGE_HOME`、`AGY_BRIDGE_DEFAULT_EFFORT`、`AGY_BRIDGE_MAX_SESSIONS`、`AGY_BRIDGE_AUTO_SWITCH`、`AGY_BRIDGE_VAULT` 等。

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

1. ✅ 账号金库 + 切号执行（已验证：主号⇄其它号真实互换、假凭据演练×3、备份/恢复可靠）
2. 轮次边界额度判断 → 自动切号 → 会话重建重放（未动工）
3. `accounts add` 浏览器 OAuth 登录（未动工）
4. launchd 常驻 + Pi provider 配置（未动工）

## 2026-11-06 切号实测结论

- agy CLI 在 macOS 上的认证源是钥匙串条目（`security … -s gemini -a antigravity`）；会话文件 `~/.gemini/antigravity-cli/antigravity-oauth-token` 只是镜像，移走照样认证、不会重建。切号必须两处都写。
- `agy --hub` 是 agy 按需拉起的守护进程，持有旧凭据内存副本；切换前必须关掉，下一次 agy 调会用新凭据重建。桥已自动处理。
- agy-switch 的“先刷新目标 token 再写入”策略已移植：目标号刷新失败 = 零写入安全中止。
- 主号（未入过 agy-switch 金库）已用 `import-current` 收入金库，标记 main。
- **金库存量号 a-test-account 实测被 Google 以违反服务条款禁用（403，"service disabled for violation of ToS"）**，登录态活着但服务被拒。自动切号当前没有可用目标号。
- 风险声明的条款风险已在本机发生过一次：多号轮换是 Google 明文禁止的行为，这批号大概率图此被禁。后续若新增账号重试同样模式，预期同样结局。
