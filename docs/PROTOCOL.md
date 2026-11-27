# 协议说明

客户端只和本机的 `dsh web` 说话。全部实现在 `src/dsh-remote.mjs`（约 200 行）。

## 1. 认证

```http
GET /connect?token=<DSH_HOME/.launch-token>&interactions=answer
  → 302, Set-Cookie: dsh-auth-<hash>=...
```

之后所有请求带上这个 cookie。`interactions=answer` 让服务端把交互式审批交给本客户端，否则工具调用会一直等待。

拿到 cookie 后开一条多路复用 WebSocket：

```
ws://127.0.0.1:<PORT>/api/remote.mux        （带 cookie）
```

## 2. 两种 RPC 形态

### unary

```http
POST /api/<namespace>/<method>
Content-Type: application/json

{ "type": "client-request", "rpcId": "<uuid>",
  "method": "<namespace>/<method>", "payload": { "args": { ... } } }
```

```json
{ "type": "server-response", "rpcId": "...", "result": { "ok": true, "value": ... } }
```

失败时 `result.ok === false`，`result.error` 里带 `code` 与 `message`。

### stream（WebSocket 多路复用）

```json
{ "type": "open", "streamId": "<uuid>", "endpoint": "<ns>/<method>", "payload": { "args": { ... } } }

{ "type": "item",   "streamId": "...", "value": { ... } }
{ "type": "end",    "streamId": "..." }
{ "type": "error",  "streamId": "...", "error": { "message": "..." } }
{ "type": "cancel", "streamId": "..." }
```

## 3. 用到的端点

| 端点 | 参数 |
|---|---|
| `session/create` | `{ request: { cwd?, workspaceId?, sessionId?, agentPreset? } }` |
| `session/prompt` | `{ request: { requestId, sessionId, mode: "queue" \| "steer", content: [{ type: "text", text }], clientTimeZone? } }` |
| `session/cancel` | `{ request: { sessionId } }` |
| `session/follow`（流） | `{ request: { address: { kind: "session", sessionId }, activate: true, assistantStream: true } }` |
| `agentTeams/setEnabled` | `{ agentId, enabled }` ← **平铺，不要包 `args`** |

`agentTeams/setEnabled` 是踩过的坑：网关按 descriptor 校验，多包一层直接报

```
gateway/arguments-invalid
typert gateway: agentTeams/setEnabled: args fields do not match the descriptor:
missing "agentId", "enabled"; unexpected "args"
```

## 4. session/follow 的帧结构

实测三类：

```
snapshot          { type, header, projections, cursor, records, hasMore, assistantStream }
event             { type: "event", event: <wire event> }
assistant-stream  { type: "assistant-stream", frame: { ... } }
```

`assistant-stream` 的 frame 是逐 token 的：

```jsonc
{ "type": "start", "attemptId": "...", "turn": 1, "step": 1 }
{ "type": "chunk", "attemptId": "...", "index": 0,
  "chunk": { "type": "text-delta", "text": "..." } }
{ "type": "chunk", "index": 1, "chunk": { "type": "reasoning-delta", "text": "..." } }
{ "type": "chunk", "index": 2, "chunk": { "type": "block-start", "blockType": "reasoning" } }
{ "type": "end",   "attemptId": "...", "outcome": "..." }
```

客户端关心的 durable 事件（`event`）：

```ts
'turn/end':          { turn, reason }        // reason 可能是对象，别当字符串拼
'tool/call':         { turn, step, callId, name, arguments /* JSON 字符串 */ }
'tool/result':       { turn, step, message, error?: { name, code, reason? }, meta? }
'assistant/message': { turn, step, message, stream, usage?, interrupted? }
'request/context':   { contextWindow, ... }
'team/mode':         { enabled }
'step/end':          { turn, step }          // 注意：没有 usage
```

## 5. 为什么不能用全局 `$events`

`assistant/stream` 在服务端转发白名单里**没有 `resources` 声明**，属于 global 广播：

```js
// @deepseek-ai/dsh-api-remotes
{ event: "assistant/stream", mode: "emit" }   // 无 resources → 全局
```

即同一个 daemon 上**任何会话**的 token 流都会推给所有订阅者。用它做逐字渲染，终端里会冒出别人的对话内容。

正确做法是 `session/follow`：会话作用域，同时给 durable event 和 `assistantStream` 增量。

另外 `snapshot` 里带整段历史记录，客户端应**只把它当游标**，不要回放打印，否则每次重开会话都会把旧对话重打一遍。

## 6. 排版约定

| 元素 | 形态 |
|---|---|
| 用户输入 | `> 文本` |
| 思考中 | `◐ Thinking… (esc to interrupt · 4s · 1.2k 字)` |
| 思考结束 | `▪ Thought for 4s` |
| 工具调用 | `● Bash(cmd)`，参数按终端宽度裁成单行 |
| 工具结果 | `└ 首行 · 0.3s`，续行缩进 5 格，超过 3 行折叠为 `… +N 行` |
| 改动面板 | `┌─ 文件 +N -M ───` / `行号│-旧` / `行号│+新` / `└────` |
| 回合结束 | `▪ Worked for 12s · 3120 in / 284 out · 24 字/秒` |

图标只用几何字符与制表符（`● └ ▪ ◐ ◓ ◑ ◒ ◈ ◆ ◂ ▶ ◇ »`），不用 emoji——iOS 终端会把部分符号渲染成彩色 emoji，破坏对齐。

## 7. 在终端里验证渲染的方法

TUI 的问题（光标错位、折行串行、字幕残留）看日志看不出来。可行做法：

1. 用 `pty.fork()` 起伪终端，在里面运行 `ds`
2. 定时向 fd 写指令，同时把读到的字节全部存下来
3. 用最小 ANSI 终端模拟器回放这些字节（处理 `\r`、`\x1b[nA`、`\x1b[0J`、宽字符宽度），把屏幕还原成文本逐帧比对

两个注意点：

- **回放宽度必须和 TUI 一致**。pty 在部分平台不报窗口尺寸，程序会回退到 80，此时必须按 80 回放，否则会看到大量"幽灵重复"——那是模拟器宽度不一致造成的假象。
- **快照点要落在完整转义之后**，否则会把 `\x1b[38;2;…m` 从中间截断，回放出不存在的故障。
