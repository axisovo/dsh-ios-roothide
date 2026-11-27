// dsh-remote — 直连本机 dsh web 的常驻客户端（零冷启动）。
//
// 协议（实测）：
//   认证   GET /connect?token=<launch-token>  → 302 + dsh-auth-* cookie
//   unary  POST /api/<endpoint>  body {type:"client-request",rpcId,method,payload:{args}}
//          resp {type:"server-response",rpcId,result:{ok,value|error}}
//   stream WS /api/remote.mux（带 cookie）
//          发 {type:"open",streamId,endpoint,payload:{args}}
//          收 {type:"item",streamId,value} / {type:"end"} / {type:"error"}
//
// 用到的端点（descriptor 见 dsh-api-session-controller/lib/typert.host.js）：
//   session/create         {request:{cwd?|workspaceId?,sessionId?,agentPreset?}}
//   session/prompt         {request:{requestId,sessionId,mode,content:[{type:"text",text}]}}
//   session/cancel         {request:{sessionId}}
//   session/observeEvent   stream {request:{address:{kind:"session",sessionId}}}
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * ws 模块的解析顺序：
 *   1. 环境变量 DSH_WS_MODULE（iOS 上通常指向 dsh 自带的纯 JS 副本）
 *   2. 当前项目的依赖（npm i ws）
 *   3. 同目录下的 vendor/ws（把 ws 整个目录拷进来即可，jitless 环境用）
 * 纯 JS 实现在无 JIT 的环境下也能跑，这是 iOS 上不带原生扩展的原因。
 */
function resolveWebSocket() {
  const candidates = [
    process.env.DSH_WS_MODULE,
    "ws",
    new URL("./vendor/ws/index.js", import.meta.url).pathname,
  ].filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) { errors.push(`${candidate}: ${error.message}`); }
  }
  throw new Error(`找不到 ws 模块。安装依赖（npm i ws）或设置 DSH_WS_MODULE。\n${errors.join("\n")}`);
}

let WebSocketClass = null;
/** 延迟解析：让 --help / 未安装依赖时也能给出可读提示，而不是在 import 阶段炸掉。 */
function getWebSocket() {
  if (!WebSocketClass) WebSocketClass = resolveWebSocket();
  return WebSocketClass;
}

// 复用连接：每轮新建 TCP 时偶发 ECONNRESET（服务端连接管理），保持 keep-alive 更稳。
const AGENT = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 4 });

export class RemoteClient {
  constructor({ home, port = 3081 } = {}) {
    this.home = home || process.env.DSH_HOME;
    this.port = port;
    this.cookie = "";
    this.ws = null;
    this.pending = new Map();
    this.streams = new Map();
  }

  async connect() {
    if (!this.home) throw new Error("没有指定 DSH_HOME（dsh 的数据目录，里面应有 .launch-token）");
    const tokenPath = `${this.home}/.launch-token`;
    if (!fs.existsSync(tokenPath)) throw new Error(`找不到启动令牌：${tokenPath}（先启动 dsh web）`);
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const res = await new Promise((resolve, reject) => {
      http.get(
        { host: "127.0.0.1", port: this.port, path: `/connect?token=${encodeURIComponent(token)}&interactions=answer`, headers: { host: `127.0.0.1:${this.port}` } },
        (response) => { response.resume(); resolve(response); },
      ).on("error", reject);
    });
    this.cookie = (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
    if (!this.cookie) throw new Error(`认证失败（HTTP ${res.statusCode}），检查 .launch-token 与 3081`);

    const WebSocket = getWebSocket();
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/api/remote.mux`, {
      headers: { cookie: this.cookie, host: `127.0.0.1:${this.port}` },
    });
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => this.#onFrame(data));
    this.ws.on("close", () => {
      for (const entry of this.pending.values()) entry.reject(new Error("连接已断开"));
      this.pending.clear();
    });
    return this;
  }

  #onFrame(data) {
    let frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    const stream = this.streams.get(frame.streamId);
    if (stream) {
      if (frame.type === "item") stream.onItem(frame.value);
      else if (frame.type === "error") { stream.onError(new Error(frame.error?.message || "stream error")); this.streams.delete(frame.streamId); }
      else if (frame.type === "end") { stream.onEnd?.(); this.streams.delete(frame.streamId); }
      return;
    }
    const entry = this.pending.get(frame.streamId);
    if (!entry) return;
    if (frame.type === "item") { entry.items.push(frame.value); return; }
    this.pending.delete(frame.streamId);
    if (frame.type === "end") entry.resolve(entry.items);
    else entry.reject(new Error(frame.error?.message || "rpc error"));
  }

  /** 调一次 unary RPC；瞬时网络错误重试一次。 */
  async call(method, args, timeoutMs = 60000) {
    try {
      return await this.#callOnce(method, args, timeoutMs);
    } catch (error) {
      const transient = /ECONNRESET|EPIPE|socket hang up|连接已断开/.test(String(error?.message || ""));
      if (!transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return this.#callOnce(method, args, timeoutMs);
    }
  }

  #callOnce(method, args, timeoutMs = 60000) {
    const body = JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload: { args } });
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          agent: AGENT,
          path: `/api/${method}`,
          method: "POST",
          headers: {
            cookie: this.cookie,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            host: `127.0.0.1:${this.port}`,
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => {
            if (response.statusCode !== 200) return reject(new Error(`${method}: HTTP ${response.statusCode} ${text.slice(0, 200)}`));
            let payload;
            try { payload = JSON.parse(text); } catch { return reject(new Error(`${method}: 响应不是 JSON`)); }
            if (payload.result?.ok === false) {
              const error = payload.result.error || {};
              return reject(new Error(`${method}: ${error.code || ""} ${error.message || JSON.stringify(error)}`.trim()));
            }
            resolve(payload.result?.value);
          });
        },
      );
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`${method}: 超时`)));
      request.on("error", reject);
      request.write(body);
      request.end();
    });
  }

  /** 开一条流（WebSocket mux）。返回 { close() }。 */
  stream(endpoint, args, { onItem, onError, onEnd } = {}) {
    const streamId = crypto.randomUUID();
    this.streams.set(streamId, { onItem, onError, onEnd });
    this.ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    return {
      streamId,
      close: () => {
        if (!this.streams.has(streamId)) return;
        this.streams.delete(streamId);
        try { this.ws.send(JSON.stringify({ type: "cancel", streamId })); } catch { /* 已断开 */ }
      },
    };
  }

  async createSession({ cwd } = {}) {
    const value = await this.call("session/create", { request: cwd ? { cwd } : {} });
    if (!value?.sessionId) throw new Error("session/create 没有返回 sessionId");
    return value.sessionId;
  }

  /** mode: "queue" = 等当前回合结束再发；"steer" = 立刻插进当前回合。 */
  async prompt(sessionId, text, mode = "queue") {
    return this.call("session/prompt", {
      request: {
        requestId: crypto.randomUUID(),
        sessionId,
        mode,
        content: [{ type: "text", text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
    });
  }

  async cancel(sessionId) {
    return this.call("session/cancel", { request: { sessionId } });
  }

  observe(sessionId, handlers) {
    return this.stream(
      "session/observeEvent",
      { request: { address: { kind: "session", sessionId } } },
      handlers,
    );
  }

  close() {
    try { this.ws?.close(); } catch { /* 已关闭 */ }
  }
}
