// dsh-live — 常驻连接版 TUI：连本机 3081 的 dsh，零冷启动。
//
// 与 dsh-tui.mjs（每轮起一个 headless 进程，26 秒）的区别：
//   · 一次认证 + 一条 WebSocket，之后每轮只发一次 HTTP RPC
//   · 和 web 端共用同一个 agent / 同一个 session（网页里能看到同一段对话）
//   · 事件从 session/observeEvent 流里来
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteClient } from "./dsh-remote.mjs";
import { activityLine, TICK, grayscalePalette } from "./dsh-anim.mjs";
import { renderWhale } from "./dsh-whale.mjs";
import { LineEditor, textWidth, stripAnsi } from "./dsh-input.mjs";
import { alignLines, withLineNumbers, trimContext, diffStats } from "./dsh-diff.mjs";

// 所有输出都从这里走：编辑区启动后改成 editor.print，输出就自动插到输入行上方。
let OUT = (text) => process.stdout.write(text);

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dsh 数据目录：优先环境变量，其次 ~/.dsh（含 .launch-token 与 sessions/）。 */
const HOME = process.env.DSH_HOME
  || process.env.DSH_DIR
  || path.join(process.env.HOME || process.cwd(), ".dsh");
const SESSION_FILE = path.join(HOME, "dsh-purge", "live-session");
const SERVER_PORT = Number(process.env.DSH_PORT || 3081);

const ESC = "\x1b[";
const fmtCount = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const dim = (t) => `${ESC}2m${t}${ESC}0m`;
const bold = (t) => `${ESC}1m${t}${ESC}0m`;
const blue = (t) => `${ESC}38;5;69m${t}${ESC}0m`;
const green = (t) => `${ESC}32m${t}${ESC}0m`;
const red = (t) => `${ESC}31m${t}${ESC}0m`;
/** 色块：用 ▌ 配 256 色前景，替代 emoji 图标。 */
const cyan = (t) => `${ESC}36m${t}${ESC}0m`;
const yellow = (t) => `${ESC}33m${t}${ESC}0m`;
const magenta = (t) => `${ESC}35m${t}${ESC}0m`;
const underline = (t) => `${ESC}4m${t}${ESC}0m`;

/**
 * 动作分类：让用户一眼看出 agent 在干什么。
 * 读 / 改 / 跑 / 技能 / 其它，各自一套颜色 + 图标 + 关键词。
 */
function classifyTool(name) {
  const n = String(name || "tool");
  if (/^(read|glob|grep|session_query)$/.test(n)) return { kind: "读取", color: blue, icon: "◂" };
  if (/^(write|edit|apply_patch)$/.test(n)) return { kind: "修改", color: yellow, icon: "◆" };
  if (/^(bash|pwsh|terminal|jobs)$/.test(n)) return { kind: "执行", color: cyan, icon: "▶" };
  if (/skill/i.test(n)) return { kind: "技能", color: magenta, icon: "◈" };
  if (/^(web_search|web_fetch)$/.test(n)) return { kind: "检索", color: blue, icon: "◇" };
  if (/^(subagent|workflow|ralph)$/.test(n)) return { kind: "委派", color: magenta, icon: "»" };
  return { kind: "工具", color: green, icon: "◆" };
}
const italic = (t) => `${ESC}3m${t}${ESC}0m`;

/** 图标一律用几何/色块/制表符，禁止 emoji（iOS 终端会把部分符号渲染成彩色 emoji）。 */
const block = (color) => `${ESC}38;5;${color}m▌${ESC}0m`;

function dshVersion() {
  try {
    const candidates = [
      process.env.DSH_PKG,
      path.resolve(HERE, "..", "..", "dsh", "node_modules", "@deepseek-ai", "dsh", "package.json"),
      path.resolve(HERE, "..", "package.json"),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try { return JSON.parse(fs.readFileSync(candidate, "utf8")).version; } catch { /* 换下一个 */ }
    }
    return "?";
  } catch { return "?"; }
}

// DeepSeek 小鲸鱼：直接复用 @deepseek-harness-tui 的像素素材（42×30，
// 半块字符渲染成 42 列 × 15 行，24 位真彩色），比自己画块字符好看得多。
/** 鲸鱼像素素材（可选）：来自 @deepseek-harness-tui/dsh-tui 的 assets/deepy/frames.json。 */
const WHALE_CANDIDATES = [
  process.env.DSH_WHALE_ASSET,
  path.resolve(HERE, "..", "assets", "frames.json"),
  path.join(HOME, "profiles", "dsh-tui", "node_modules", "@deepseek-harness-tui", "dsh-tui", "assets", "deepy", "frames.json"),
  path.resolve(HERE, "..", "dsh-home", "profiles", "dsh-tui", "node_modules", "@deepseek-harness-tui", "dsh-tui", "assets", "deepy", "frames.json"),
].filter(Boolean);

let whale = null;
function loadWhale() {
  if (whale !== null) return whale;
  whale = false;
  for (const candidate of WHALE_CANDIDATES) {
    try { whale = JSON.parse(fs.readFileSync(candidate, "utf8")); break; } catch { /* 换下一个候选 */ }
  }
  return whale;
}

function rgb(hex) {
  const h = String(hex).replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}






// ── 流式 markdown 轻量渲染 ──────────────────────────────────────────
// 逐行处理：代码块用左边框，行内代码反色，粗体加粗，标题上色，列表标记。
// 不追求完整 CommonMark（流式场景下块边界不稳定），只做观感。
const codeLine = (text) => `${dim("│")} ${text}`;

function renderInline(text) {
  let out = text;
  // 行内代码 `x` → 反色
  out = out.replace(/`([^`]+)`/g, (_, code) => `\x1b[7m${code}\x1b[0m`);
  // 粗体 **x**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, boldText) => `\x1b[1m${boldText}\x1b[0m`);
  // 斜体 *x*（避开已处理的 **）
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, lead, em) => `${lead}\x1b[3m${em}\x1b[0m`);
  // 链接 [text](url) → text (url) 下划线
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `\x1b[4m${label}\x1b[0m ${dim(url)}`);
  return out;
}

/** 一行 markdown → 终端输出（不含换行）。 */
function renderMarkdownLine(line, state) {
  const fence = line.trim().startsWith("```");
  if (fence) {
    const lang = line.trim().slice(3).trim();
    state.inCode = !state.inCode;
    state.lang = state.inCode ? lang.toLowerCase() : "";
    return state.inCode
      ? `${dim("┌─")} ${dim(lang || "code")}`
      : `${dim("└─")}`;
  }
  if (state.inCode) {
    // diff：新增绿、删除红、hunk 头青，和 harness 的改动色一致
    const isDiff = state.lang === "diff" || state.lang === "patch";
    if (line.startsWith("+++") || line.startsWith("---")) return codeLine(bold(line));
    if (isDiff || /^[+-]/.test(line)) {
      if (line.startsWith("+")) return codeLine(green(line));
      if (line.startsWith("-")) return codeLine(red(line));
      if (line.startsWith("@@")) return codeLine(blue(line));
    }
    if (line.startsWith("@@")) return codeLine(blue(line));
    return codeLine(line);
  }
  if (/^#{1,6}\s/.test(line)) {
    const level = line.match(/^#+/)[0].length;
    return blue(`\x1b[1m${line.replace(/^#+\s*/, "")}\x1b[0m`) + (level <= 2 ? "" : "");
  }
  if (/^\s*[-*+]\s/.test(line)) {
    return renderInline(line.replace(/^(\s*)[-*+]\s/, (_, indent) => `${indent}${blue("•")} `));
  }
  if (/^\s*\d+\.\s/.test(line)) {
    return renderInline(line.replace(/^(\s*)(\d+)\.\s/, (_, indent, num) => `${indent}${blue(num + ".")} `));
  }
  if (/^>\s?/.test(line)) return dim("│ " + line.replace(/^>\s?/, ""));
  return renderInline(line);
}

/** 把 edit / write / apply_patch 的参数渲染成绿加红删的差异块。 */
function unescapeJson(text) {
  return String(text).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function parseToolInput(rawInput) {
  let input = rawInput;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch {
      const raw = String(rawInput);
      const pick = (key) => {
        const hit = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
        return hit ? unescapeJson(hit[1]) : undefined;
      };
      input = { file_path: pick("file_path"), old_string: pick("old_string"), new_string: pick("new_string"), content: pick("content"), patch: pick("patch") };
    }
  }
  return input && typeof input === "object" ? input : null;
}

/** 读文件定位 old_string 的真实行号（读不到就从 1 开始）。 */
function locateStartLine(file, oldLines) {
  if (!file || oldLines.length === 0) return 1;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return 1;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i + oldLines.length <= lines.length; i += 1) {
      let hit = true;
      for (let k = 0; k < oldLines.length; k += 1) {
        if (lines[i + k] !== oldLines[k]) { hit = false; break; }
      }
      if (hit) return i + 1;
    }
  } catch { /* 文件不存在或是新写入 */ }
  return 1;
}

/** 把一次文件改动变成 { file, rows, stats }，供 diff 面板渲染。 */
function buildFileChange(name, rawInput) {
  const input = parseToolInput(rawInput);
  if (!input) return null;
  const file = input.file_path || input.path || input.target || "";

  if (/edit|apply_patch/i.test(name) && (typeof input.old_string === "string" || typeof input.new_string === "string")) {
    const oldText = String(input.old_string ?? "");
    const newText = String(input.new_string ?? "");
    const oldLines = oldText.split("\n");
    const start = locateStartLine(file, oldLines);
    const aligned = withLineNumbers(alignLines(oldText, newText), start);
    return { file, rows: trimContext(aligned, 2), stats: diffStats(aligned) };
  }

  if (/write/i.test(name) && typeof input.content === "string") {
    const body = input.content.endsWith("\n") ? input.content.slice(0, -1) : input.content;
    const contentLines = body.split("\n");
    const rows = withLineNumbers(contentLines.map((text) => ({ type: "add", text })), 1);
    const shown = rows.slice(0, 12);
    if (rows.length > shown.length) shown.push({ type: "gap", text: "⋯" });
    return { file, rows: shown, stats: { additions: contentLines.length, removals: 0 } };
  }
  return null;
}

/** 渲染 diff 面板：行号 + −/+ 标记 + 上下边框，改动一眼可见。 */
function renderDiffPanel(diff) {
  if (!diff) return;
  const width = process.stdout.columns || 80;
  const pad = "     "; // 和 ⎿ 的续行缩进对齐
  const inner = Math.max(28, Math.min(width - pad.length - 2, 78));
  const nums = diff.rows.filter((r) => typeof r.no === "number").map((r) => r.no);
  const numW = Math.max(3, String(nums.length > 0 ? Math.max(...nums) : 1).length);
  const counts = `${green("+" + diff.stats.additions)} ${red("-" + diff.stats.removals)}`;
  const titleRaw = clipTo(diff.file || "diff", inner - 12);
  const used = textWidth(titleRaw) + 1 + textWidth(`+${diff.stats.additions} -${diff.stats.removals}`);
  OUT(`${pad}${dim("┌─ ")}${bold(titleRaw)} ${counts} ${dim("─".repeat(Math.max(2, inner - used - 2)))}\n`);
  for (const row of diff.rows) {
    if (row.type === "gap") { OUT(`${pad}${dim(" ".repeat(numW))}${dim("│")} ${dim("⋯")}\n`); continue; }
    const no = String(row.no ?? "").padStart(numW);
    const mark = row.type === "add" ? green("+") : row.type === "del" ? red("-") : dim(" ");
    const room = Math.max(8, inner - numW - 3);
    const text = clipTo(row.text ?? "", room);
    const body = row.type === "add" ? green(text) : row.type === "del" ? red(text) : dim(text);
    OUT(`${pad}${dim(no)}${dim("│")}${mark} ${body}\n`);
  }
  OUT(`${pad}${dim("└" + "─".repeat(inner))}\n`);
}


function banner(sessionId) {
  // pty/部分终端不上报宽度，回退 80，否则鲸鱼会被判成"放不下"而不画
  const cols = process.stdout.columns || 80;
  const width = cols > 20 ? Math.min(cols - 2, 72) : 44;
  const ver = dshVersion();
  // 小鲸鱼：面积平均采样 → 半块渲染。宽度随终端自适应，太窄就不画。
  const whaleCols = cols >= 76 ? 30 : cols >= 60 ? 24 : cols >= 44 ? 18 : 0;
  const whaleRows = whaleCols >= 24 ? 10 : 8;
  let art = [];
  const data = loadWhale();
  if (data && data.animations && whaleCols > 0) {
    const pick = Object.values(data.animations).find((a) => a.key === "idle") || Object.values(data.animations)[0];
    const rows = pick?.frames?.[0]?.rows;
    if (rows) art = renderWhale({ rows, palette: data.palette, cols: whaleCols, outRows: whaleRows });
  }
  const info = [
    `${bold("DeepSeek")} ${dim("v" + ver)}`,
    `${dim(process.platform + "-" + process.arch)}`,
    `${dim("node " + process.version)}`,
    `${dim("会话")} ${sessionId ? dim(sessionId.slice(0, 14)) : dim("（新会话）")}`,
    `${dim("/help")} ${dim("·")} ${dim("/resume")} ${dim("·")} ${dim("/")}`,
  ];
  const rule = dim("─".repeat(width));
  OUT("\n");
  const lines = Math.max(art.length, info.length);
  const infoTop = art.length > info.length ? Math.floor((art.length - info.length) / 2) : 0;
  for (let i = 0; i < lines; i += 1) {
    // art 里含 ANSI，不能用 String.padEnd（它按字节长度算，会把信息挤到鲸鱼身上）
    const artLine = art[i] ?? "";
    const visible = textWidth(stripAnsi(artLine));
    const left = artLine + " ".repeat(Math.max(0, whaleCols + 3 - visible));
    const right = info[i - infoTop] || "";
    OUT(`  ${left}${right}\n`);
  }
  OUT(`  ${rule}\n\n`);
}

function contentText(content) {
  if (!Array.isArray(content)) return { text: "", reasoning: "" };
  let text = "";
  let reasoning = "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    if (block?.type === "reasoning" && typeof block.text === "string") reasoning += block.text;
    if (block?.type === "tool_use") text += "";
  }
  return { text, reasoning };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 逐字输出。
 *
 * 服务端不转发 token 级 chunk（gateway 只转 api-session/activity|status，
 * assistant/message 到达时整段文本已经在里面了），所以逐字在客户端做：
 * 按字符滚动，长段落自动加速，避免大段输出等太久。
 */
async function typeOut(text, paint) {
  if (!text) return;
  const chars = [...text];
  const perChar = chars.length > 600 ? 2 : chars.length > 200 ? 6 : 14;
  let buffer = "";
  let emitted = 0;
  for (const ch of chars) {
    buffer += ch;
    emitted += 1;
    if (emitted >= 3 || ch === "\n") {
      OUT(paint ? paint(buffer) : buffer);
      buffer = "";
      emitted = 0;
      await sleep(perChar * 3);
    }
  }
  if (buffer) OUT(paint ? paint(buffer) : buffer);
}

// 事件渲染串行化：onEvent 是同步回调，逐字需要 await，所以排进队列。
const renderQueue = [];
let rendering = false;
function enqueueJob(job) {
  renderQueue.push(job);
  if (rendering) return;
  rendering = true;
  (async () => {
    while (renderQueue.length > 0) {
      const next = renderQueue.shift();
      try {
        await next();
      } catch (error) {
        // 不要静默吞掉：渲染出错时日志里能看到，否则表现为"少了一整块输出"
        try {
          fs.appendFileSync(path.join(HOME, "logs", "live-render.log"), `[${new Date().toISOString()}] ${error?.stack || error}\n`);
        } catch { /* 日志写不了就算了 */ }
      }
    }
    rendering = false;
  })();
}

/** 终端显示宽度：CJK / 全角算 2 列。 */
function useWidth(ch) {
  const code = ch.codePointAt(0);
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1;
}
function clipTo(text, maxCols) {
  let width = 0;
  let out = "";
  for (const ch of String(text)) {
    const w = useWidth(ch);
    if (width + w > maxCols) break;
    out += ch;
    width += w;
  }
  return out;
}
function padTo(text, maxCols) {
  const clipped = clipTo(text, maxCols);
  let width = 0;
  for (const ch of clipped) width += useWidth(ch);
  return clipped + " ".repeat(Math.max(0, maxCols - width));
}


/** 工具名 → Claude CLI 里的显示名。 */
const TOOL_ALIAS = {
  bash: "Bash", read: "Read", write: "Write", edit: "Update", apply_patch: "Update",
  glob: "Glob", grep: "Grep", web_search: "Search", web_fetch: "Fetch",
  skill: "Skill", subagent: "Task", workflow: "Workflow", present: "Present",
  schedule_create: "Schedule", schedule_list: "Schedule", schedule_edit: "Schedule", schedule_view: "Schedule",
};
const toolTitle = (name) => TOOL_ALIAS[String(name || "").toLowerCase()] || (String(name || "tool")[0] || "T").toUpperCase() + String(name || "ool").slice(1);

/** 从工具参数里挑出最能代表这次调用的那一个值。 */
function toolArgText(name, raw) {
  let args = {};
  try { args = typeof raw === "string" ? JSON.parse(raw) : (raw && typeof raw === "object" ? raw : {}); } catch { args = {}; }
  const pick = (...keys) => keys.map((k) => args[k]).find((v) => typeof v === "string" && v.length > 0) || "";
  const oneLine = (t) => String(t).replace(/\s+/g, " ").trim();
  const n = String(name || "").toLowerCase();
  if (/bash|shell|terminal/.test(n)) return clipTo(oneLine(pick("command", "cmd", "script")), 72);
  if (/^(read|write|edit|apply_patch)$/.test(n)) return clipTo(oneLine(pick("file_path", "path", "file")), 72);
  if (/glob/.test(n)) return clipTo(oneLine(pick("pattern")), 48);
  if (/grep/.test(n)) return [pick("pattern"), pick("path")].filter(Boolean).map((x) => clipTo(oneLine(x), 28)).join(" · ");
  if (/web_fetch/.test(n)) return clipTo(oneLine(pick("url")), 72);
  if (/web_search/.test(n)) return clipTo(oneLine(pick("query")), 72);
  if (/skill/.test(n)) return clipTo(oneLine(pick("name", "skill")), 32);
  if (/subagent|task|workflow/.test(n)) return clipTo(oneLine(pick("description", "prompt", "task")), 64);
  const first = Object.values(args).find((v) => typeof v === "string" && v.length > 0);
  return clipTo(oneLine(first || ""), 64);
}

/** 工具结果的纯文本（message.content 里的 text 块）。 */
function toolResultText(data) {
  const content = data?.message?.content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  if (typeof content === "string") return content;
  if (typeof data?.message === "string") return data.message;
  return "";
}


/** 拖拽/粘贴进来的文本 → 归一化后的路径列表（去 file://、去引号、解转义空格、展开 ~）。 */
function normalizeDropped(text) {
  const raw = String(text).replace(/\x1b\[20[01]~/g, "").trim();
  if (!raw) return [];
  const home = process.env.HOME || "";
  return raw.split(/\r?\n/).map((piece) => {
    let value = piece.trim();
    if (value.startsWith("file://")) {
      try { value = decodeURIComponent(value.slice("file://".length)); } catch { value = value.slice("file://".length); }
    }
    value = value.replace(/^["'](.*)["']$/s, "$1");
    value = value.replace(/\\ /g, " ");
    if (value === "~" || value.startsWith("~/")) value = home + value.slice(1);
    return value;
  }).filter((value) => value.length > 0);
}

const COMMANDS = [
  ["/help", "显示命令列表"],
  ["/model [名字]", "查看或切换模型"],
  ["/think [级别]", "思考深度：off | low | medium | high"],
  ["/usage", "token 用量：当前会话 + 全部汇总"],
  ["/plugins", "已加载的插件 / bundle"],
  ["/tasks", "自动化定时任务"],
  ["/skills", "列出当前会话可用的 skills"],
  ["/resume", "从历史会话里挑一个继续"],
  ["/rename [标题]", "给当前会话起个名字"],
  ["/fork", "从当前会话分叉出一个新的"],
  ["/new", "开一个新会话"],
  ["/session", "显示当前会话 id"],
  ["/team [on|off]", "团队智能体协作模式"],
  ["/stop", "中断当前回合"],
  ["/clear", "清屏"],
  ["/exit", "退出"],
];

const EFFORT_LEVELS = ["off", "low", "medium", "high"];

function showHelp() {
  OUT("\n");
  for (const [name, desc] of COMMANDS) {
    OUT(`  ${blue(name.padEnd(16))}${dim(desc)}\n`);
  }
  OUT("\n");
}

async function main() {
  let client;
  try {
    client = await new RemoteClient({ home: HOME, port: SERVER_PORT }).connect();
  } catch (error) {
    OUT(`${red("连接失败：")}${error.message}\n`);
    process.exit(1);
  }

  let sessionId = (() => { try { return fs.readFileSync(SESSION_FILE, "utf8").trim(); } catch { return ""; } })();
  let currentProvider = "deepseek-account";
  let currentModel = "deepseek-flash";
  let currentEffort = "high";
  let pendingResume = null; // /resume 列出的候选，等用户输入序号
  let contextWindow = 1048576; // 上下文窗口：request/context 事件到了就更新，没到用默认 1M
  const mdState = { inCode: false, lang: "" };
  let pendingUsage = null;
  let thinkingChars = 0;       // 本轮思考累计字数
  let thinkingShown = false;   // 屏幕上是否已有 thinking 行
  let mdBuffer = "";           // 不完整的行留到下一帧
  // 服务端逐字流：agent/assistant-stream（需 $events + interactions=answer）
  let streamedText = false;
  let streamedReasoning = false;
  let currentKind = null;
  let observer = null;
  let busy = false;

  async function ensureSession() {
    // 已有 sessionId 就直接复用：再调一次 session/create 可能把它重建成空会话，
    // 而 observer 仍盯在旧 id 上，第二轮就收不到任何事件（实测卡住）。
    if (sessionId) return sessionId;
    sessionId = await client.createSession({ cwd: process.cwd() });
    try { fs.writeFileSync(SESSION_FILE, sessionId); } catch {}
    return sessionId;
  }

  /**
   * 按会话订阅。注意不能用全局 `$events`：`assistant/stream` 在转发白名单里没有
   * resources 声明，属于 global 广播 —— 那样会把本机其它会话的正文也打到这个终端上。
   * `session/follow` 是会话作用域的，同时带 assistantStream（逐 token）与 durable event。
   */
  /**
   * 连上时把"最近一轮"重画出来。
   * 离开终端再回来时，agent 可能还在跑，也可能已经跑完了 —— 两种都要能看到
   * 进度（工具卡片）和结果（正文 / 结束摘要），所以这里按 durable 事件回放一轮。
   * 只回放最后一轮：整段历史回放会把屏幕刷爆。
   */
  function resumeFromSnapshot(snapshot) {
    const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
    const events = records.map((record) => record?.event ?? record).filter((event) => event && event.type);
    let start = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].type === "turn/start") { start = i; break; }
    }
    const slice = events.slice(start);
    const active = snapshot?.assistantStream?.activeAttempt || (slice.length > 0 && slice[slice.length - 1].type !== "turn/end");
    if (slice.length === 0) {
      if (active) beginResumedTurn();
      return;
    }

    OUT(dim(`  ⟲ 恢复最近一轮${active ? "（仍在运行）" : ""}\n`));
    const mdLocal = { inCode: false, lang: "" };
    for (const event of slice) {
      switch (event.type) {
        case "user/message": {
          const { text } = contentText(event.data?.message?.content);
          if (text.trim().length > 0) OUT(`${dim(">")} ${clipTo(text.trim().replace(/\s+/g, " "), (process.stdout.columns || 80) - 4)}\n\n`);
          break;
        }
        case "assistant/message": {
          const { text, reasoning } = contentText(event.data?.message?.content);
          if (reasoning.trim().length > 0) OUT(`  ${dim("▪")} ${dim(`Thought ${fmtCount(reasoning.trim().length)} 字`)}\n`);
          if (text.trim().length > 0) {
            for (const line of text.trim().split("\n")) OUT("  " + renderMarkdownLine(line, mdLocal) + "\n");
          }
          break;
        }
        case "tool/call": {
          const name = event.data?.name || "tool";
          const title = toolTitle(name);
          const arg = clipTo(toolArgText(name, event.data?.arguments), Math.max(12, (process.stdout.columns || 80) - title.length - 8));
          OUT(`  ${dim("●")} ${classifyTool(name).color(title)}${dim("(")}${dim(arg)}${dim(")")}\n`);
          break;
        }
        case "tool/result": {
          const failed = !!event.data?.error;
          const body = failed
            ? (event.data.error?.reason || event.data.error?.code || "失败")
            : (toolResultText(event.data).split("\n").find((line) => line.trim().length > 0) || "完成");
          OUT(`  ${dim("└")} ${failed ? red(clipTo(String(body), 70)) : dim(clipTo(String(body), 70))}\n`);
          break;
        }
        case "turn/end": {
          OUT(`  ${dim("▪")} ${dim("上一轮已结束")}\n`);
          break;
        }
        default:
          break;
      }
    }
    OUT("\n");
    if (active) beginResumedTurn();
  }

  /** 接管一个"已经在跑"的回合：保持 busy，不放开输入，继续接收后续增量。 */
  function beginResumedTurn() {
    busy = true;
    turnStarted = Date.now();
    wroteText = false;
    syncStatus();
    startAnim("Working", 0);
  }

  function subscribe(id) {
    observer?.close();
    observer = client.stream("session/follow", {
      request: { address: { kind: "session", sessionId: id }, activate: true, assistantStream: true },
    }, {
      onItem: (item) => {
        if (!item) return;
        if (item.type === "snapshot") {
          const projection = item.projections?.values ?? {};
          if (projection.contextWindow) contextWindow = projection.contextWindow;
          resumeFromSnapshot(item);
          return;
        }
        if (item.type === "assistant-stream") { onFrameDelta(item.frame); return; }
        if (item.type === "event") { onEvent(item.event); return; }
        onEvent(item);
      },
      onError: (error) => OUT(`\n${red("流断开：")}${error.message}\n`),
    });
  }

  let turnDone = null;
  let wroteText = false;

  /** 活动行：Claude 风格的一行状态，随动效刷新。 */
  function startAnim(verb = "Thinking", tokens = 0) {
    animVerb = verb;
    animTokens = tokens;
    if (!animTimer) { animStarted = Date.now(); animPhase = 0; }
    const paint = () => {
      animPhase += 1;
      editor.setActivity(activityLine({
        verb: animVerb,
        elapsedMs: Date.now() - animStarted,
        tokens: animTokens,
        phase: animPhase,
      }));
      animTimer = setTimeout(paint, TICK);
    };
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    paint();
  }

  function stopAnim() {
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    editor.setActivity("");
  }

  function clearSpinnerLine() {
    stopAnim();
  }

  // 逐字流：frame.type = start / chunk / end（来自 session/follow 的 assistant-stream 帧）
  function onFrameDelta(frame) {
    if (!frame) return;
    if (frame.type === "start") {
      streamedText = false;
      streamedReasoning = false;
      thinkStarted = 0;
      thinkingChars = 0;
      return;
    }
    if (frame.type !== "chunk") return;
    const chunk = frame.chunk;
    if (!chunk) return;

    if (chunk.type === "block-start") {
      streamedReasoning = chunk.blockType === "reasoning";
      return;
    }

    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      if (thinkingShown) {
        // 思考收敛成一行，跟 Claude 一样只留一句
        thinkingShown = false;
        OUT(`  ${dim("▪")} ${dim(`Thought for ${thinkStarted ? Math.round((Date.now() - thinkStarted) / 1000) : 0}s`)}\n`);
        if (!needsBlank) { OUT("\n"); needsBlank = true; }
      }
      stopAnim();
      streamedText = true;
      streamChars += [...chunk.text].length;
      mdBuffer += chunk.text;
      let cut;
      while ((cut = mdBuffer.indexOf("\n")) >= 0) {
        const line = mdBuffer.slice(0, cut);
        mdBuffer = mdBuffer.slice(cut + 1);
        OUT("  " + renderMarkdownLine(line, mdState) + "\n");
        needsBlank = false;
      }
      editor.setTail("  " + mdBuffer);
      return;
    }

    if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
      if (!thinkStarted) { thinkStarted = Date.now(); thinkingChars = 0; }
      thinkingChars += [...chunk.text].length;
      thinkingShown = true;
      startAnim("Thinking", thinkingChars);
      return;
    }
  }

  /** 工具结果统一用 └ 接，续行缩进 5 格（和 Claude CLI 一致）。 */
  function printResult(head, lines, { error = false, secs = null } = {}) {
    const cols = process.stdout.columns || 80;
    const tail = secs === null ? "" : ` · ${secs}s`;
    // 头行 + "时间后缀"必须一起算进宽度，否则后缀会被挤到下一行
    const room = Math.max(16, cols - 1 - 4 - textWidth(tail));
    const text = error ? red(clipTo(String(head).trim(), room)) : clipTo(String(head).trim(), room);
    OUT(`  ${dim("└")} ${text}${dim(tail)}\n`);
    const room2 = Math.max(16, cols - 1 - 5);
    for (const line of lines.slice(0, 3)) {
      if (String(line).trim().length === 0) continue;
      OUT(`     ${dim(clipTo(String(line).trim(), room2))}\n`);
    }
    if (lines.length > 3) OUT(`     ${dim(`… +${lines.length - 3} 行`)}\n`);
    needsBlank = true;
  }

  function onEvent(raw) {
    const event = raw && raw.event ? raw.event : raw;
    if (!event?.type) return;
    switch (event.type) {
      case "team/mode": {
        if (typeof event.data?.enabled === "boolean") {
          teamEnabled = event.data.enabled;
          syncStatus();
        }
        break;
      }
      case "request/context": {
        if (event.data?.contextWindow) contextWindow = event.data.contextWindow;
        break;
      }
      case "assistant/message": {
        const { text } = contentText(event.data?.message?.content);
        if (event.data?.usage) pendingUsage = event.data.usage;
        if (streamedText || streamedReasoning) {
          enqueueJob(async () => {
            stopAnim();
            if (thinkingShown) {
              thinkingShown = false;
              OUT(`  ${dim("▪")} ${dim(`Thought for ${thinkStarted ? Math.round((Date.now() - thinkStarted) / 1000) : 0}s`)}\n`);
            }
            editor.flushTail();   // 尾巴（含 mdBuffer 内容）已落盘，别再打一次
            mdBuffer = "";
            wroteText = true;
            needsBlank = true;
          });
          break;
        }
        // 没有逐字流时退回整段打印
        enqueueJob(async () => {
          stopAnim();
          if (text.trim().length > 0) {
            if (needsBlank) { OUT("\n"); needsBlank = false; }
            await typeOut(text);
            wroteText = true;
          }
          if (mdBuffer.length > 0) { OUT(renderMarkdownLine(mdBuffer, mdState) + "\n"); mdBuffer = ""; }
        });
        break;
      }
      case "tool/call": {
        const name = event.data?.name || "tool";
        const args = event.data?.arguments;
        enqueueJob(async () => {
          stopAnim();
          editor.setTail("");
          if (needsBlank) { OUT("\n"); }
          const cls = classifyTool(name);
          const title = toolTitle(name);
          // 参数按终端宽度裁到单行：行太长会折行，把卡片挤成三行很难看
          const room = Math.max(12, (process.stdout.columns || 80) - 1 - 2 - title.length - 3);
          const argText = clipTo(toolArgText(name, args), room);
          toolStarted = Date.now();
          OUT(`  ${dim("●")} ${cls.color(title)}${dim("(")}${dim(argText)}${dim(")")}\n`);
          try { pendingDiff = buildFileChange(name, args); } catch { pendingDiff = null; }
          startAnim(`${title}`, 0);
        });
        break;
      }
      case "tool/result": {
        const data = event.data;
        const failed = !!data?.error;
        const message = failed ? (data.error?.reason || data.error?.code || "失败") : "";
        const body = failed ? [] : toolResultText(data).split("\n").map((l) => l.replace(/\s+$/, ""));
        const head = failed ? message : (body.find((l) => l.trim().length > 0) || "完成");
        const rest = failed ? [] : body.slice(body.indexOf(head) + 1);
        const secs = toolStarted ? Math.max(0, (Date.now() - toolStarted) / 1000).toFixed(1) : null;
        enqueueJob(async () => {
          stopAnim();
          // 有 diff 时用结构化摘要替掉服务端那串原始文本（路径 + 增删数），更像 Claude
          const diff = pendingDiff;
          pendingDiff = null;
          if (diff && !failed) {
            const { additions, removals } = diff.stats;
            const verb = removals === 0 && additions > 0 ? "Wrote" : "Updated";
            const counts = `${green("+" + additions)} ${red("-" + removals)}`;
            printResult(`${verb} ${clipTo(diff.file || "", 48)}`, [], { secs });
            renderDiffPanel(diff);
            toolStarted = 0;
            return;
          }
          printResult(head, rest, { error: failed, secs });
          toolStarted = 0;
          toolStarted = 0;
        });
        break;
      }
      case "step/end":
        break;
      case "turn/end": {
        stopAnim();
        editor.setTail("");
        enqueueJob(async () => {
          editor.flushTail();   // 同上：尾巴已落盘，不要再打一遍
          mdBuffer = "";
          if (thinkingShown) {
            thinkingShown = false;
            OUT(`  ${dim("▪")} ${dim(`Thought for ${thinkStarted ? Math.round((Date.now() - thinkStarted) / 1000) : 0}s`)}\n`);
          }
          const lastTurn = queued === 0;
          const secs = Math.max(0.1, (Date.now() - turnStarted) / 1000);
          const parts = [`Worked for ${secs.toFixed(0)}s`];
          if (pendingUsage) {
            const u = pendingUsage;
            const pct = contextWindow > 0 ? (((u.inputTokens ?? 0) / contextWindow) * 100).toFixed(1) : null;
            parts.push(`${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out`);
            if (streamChars > 0) parts.push(`${(streamChars / secs).toFixed(0)} 字/秒`);
            if (pct && Number(pct) >= 0.1) parts.push(`上下文 ${pct}%`);
            pendingUsage = null;
          }
          if (lastTurn) OUT(`\n  ${dim("▪")} ${dim(parts.join(" · "))}\n`);
          const raw = event.data?.reason;
          const kind = typeof raw === "string" ? raw : (raw?.kind || raw?.type || "");
          if (kind && kind !== "completed" && kind !== "done") {
            const detail = raw && typeof raw === "object" ? (raw.message || raw.reason || "") : "";
            OUT(`  ${red("×")} ${red(String(kind))}${detail ? dim(" · " + String(detail).slice(0, 60)) : ""}\n`);
          }
          wroteText = false;
          needsBlank = false;
          if (queued > 0) {
            // 还有排队消息：服务端会接着跑下一轮，保持 busy
            queued -= 1;
            editor.setStatus(syncStatus());
            startAnim("Working", 0);
            return;
          }
          const hadPromise = !!turnDone;
          turnDone?.();
          turnDone = null;
          if (!hadPromise) {
            // 这个回合是"重连接管的"，没有等待中的 promise，得自己收尾
            busy = false;
            queued = 0;
            syncStatus();
          }
        });
        break;
      }
      default:
        break;
    }
  }

  // ── 输入区：自己管光标，busy 时也能打字 ──────────────────────
  let queued = 0;          // 排队中的条数（服务端 queue 模式）
  let turnStarted = Date.now();
  let toolLabel = "";
  let pendingDiff = null;
  let teamEnabled = false;   // 团队智能体协作模式（服务端 agentTeams/setEnabled）
  let pasteHint = "";        // 刚拖进来的文件提示，几秒后消失
  let toolStarted = 0;     // 当前工具开始时间
  let thinkStarted = 0;    // 本轮思考开始时间
  let streamChars = 0;     // 本轮正文流出的字符数（算 TPS）
  let textLines = 0;
  let needsBlank = false;
  let animTimer = null;
  let animPhase = 0;
  let animVerb = "Thinking";
  let animTokens = 0;
  let animStarted = Date.now();
  const menuState = { items: [], index: 0 };

  function menuRows() {
    const { items, index } = menuState;
    if (items.length === 0) return [];
    const limit = 8;
    const start = Math.max(0, Math.min(index - limit + 1, items.length - limit));
    const end = Math.min(start + limit, items.length);
    const rows = [];
    if (start > 0) rows.push(dim(`  ↑ 还有 ${start} 条`));
    for (let i = start; i < end; i += 1) {
      const [name, desc] = items[i];
      const selected = i === index;
      const label = padTo(name, 14);
      rows.push(`${selected ? blue("▸") : dim("·")} ${selected ? blue(label) : label} ${dim(clipTo(desc, 30))}`);
    }
    if (end < items.length) rows.push(dim(`  ↓ 还有 ${items.length - end} 条`));
    return rows;
  }

  function syncMenu() {
    if (busy) { menuState.items = []; editor.setMenu([]); return; }
    const line = editor.line || "";
    const open = line.startsWith("/") && !line.includes(" ");
    menuState.items = open ? COMMANDS.filter(([name]) => name.startsWith(line)) : [];
    if (menuState.index >= menuState.items.length) menuState.index = 0;
    editor.setMenu(menuRows());
  }

  function clearMenu() {
    menuState.items = [];
    menuState.index = 0;
    editor.setMenu([]);
  }

  function pickMenuItem(step) {
    const { items } = menuState;
    if (items.length === 0) return false;
    menuState.index = (menuState.index + step + items.length) % items.length;
    const picked = items[menuState.index][0];
    editor.setLine(/\[/.test(picked) ? picked.replace(/\s*\[.*\]$/, "") + " " : picked);
    editor.setMenu(menuRows());
    return true;
  }

  /** 状态行：团队模式徽标 + 队列 + 粘贴提示 + 快捷键。 */
  function syncStatus() {
    const parts = [];
    if (teamEnabled) parts.push(magenta("◈ team"));
    if (busy && queued > 0) parts.push(blue(`队列 ${queued}`));
    if (pasteHint) parts.push(dim(pasteHint));
    if (busy) {
      parts.push(dim("Alt+Enter 插入"));
      parts.push(dim("Esc 中断"));
    }
    editor.setStatus(parts.length > 0 ? "  " + parts.join(dim(" · ")) : "");
  }

  const editor = new LineEditor({
    prompt: blue("❯ "),
    onSubmit: (raw) => { clearMenu(); handleSubmit(raw); },
    onKey: (ch, key) => {
      const name = key?.name;
      if (menuState.items.length > 0) {
        if (name === "up") { pickMenuItem(-1); return true; }
        if (name === "down") { pickMenuItem(1); return true; }
        if (name === "tab") {
          const picked = (menuState.items[menuState.index] || menuState.items[0])[0];
          menuState.index = 0;
          editor.setLine(picked + " ");
          syncMenu();
          return true;
        }
      }
      if (name === "escape" && busy) { stopTurn(); return true; }
      setImmediate(syncMenu);
      return false;
    },
  });

  editor.onPaste = (text) => {
    const items = normalizeDropped(text);
    if (items.length === 0) return;
    const files = items.filter((value) => value.includes("/") || /\.[a-z0-9]{1,5}$/i.test(value));
    const insertText = items.join(" ");
    editor.insertText(insertText);   // 路径原样进输入框，直接可以接着说需求
    if (files.length > 0) {
      pasteHint = `⇥ 已附加 ${files.length} 个文件`;
      syncStatus();
      setTimeout(() => { pasteHint = ""; syncStatus(); }, 4000);
    }
  };

  editor.onExit = () => { editor.stop(); observer?.close(); client.close(); OUT("\n"); process.exit(0); };
  editor.onCancel = () => { if (busy) { stopTurn(); return; } editor.onExit(); };
  editor.onAltEnter = (text) => { const value = text.trim(); if (busy && value) submitBusy(value, "steer"); };

  OUT = (text) => editor.print(text);
  banner(sessionId);
  editor.start();

  // 一进来就订阅：否则要等用户先发一条消息才会收到 snapshot，
  // 离开终端期间跑的任务进度与结果就永远补不回来。
  if (sessionId) {
    try {
      subscribe(sessionId);
    } catch (error) {
      OUT(`${red("×")} 订阅会话失败：${error.message}\n`);
    }
  }

  /** busy 时的发送：queue = 等当前回合结束，steer = 立刻插进当前回合。 */
  async function submitBusy(text, mode) {
    try {
      const id = await ensureSession();
      if (!observer) subscribe(id);
      await client.prompt(id, text, mode);
      if (mode === "steer") {
        OUT(`  ${magenta("→")} ${dim("已插入当前回合")}
`);
      } else {
        queued += 1;
        editor.setStatus(syncStatus());
        OUT(`  ${blue("→")} ${dim(`已排队（第 ${queued} 条），当前回合结束后自动发`) }
`);
      }
    } catch (error) {
      OUT(`  ${red("×")} ${red(error.message)}
`);
    }
  }

  function stopTurn() {
    if (!sessionId) return;
    client.cancel(sessionId).catch(() => {});
    OUT(`  ${red("×")} ${dim("已请求中断")}
`);
  }

  async function handleSubmit(raw) {
    const line = raw.trim();
    if (line.length === 0) { editor.refresh(); return; }
    // busy 时：Enter 走排队，Alt+Enter 在 onKey 里走插入
    if (busy && !line.startsWith("/")) { await submitBusy(line, "queue"); return; }
    if (line === "/exit" || line === "/quit") return editor.onExit();
    if (line === "/clear") {
      OUT(`${ESC}2J${ESC}H`);
      banner(sessionId);
      return;
    }
    if (line === "/help") {
      showHelp();
      return;
    }
    if (line === "/session") {
      OUT(dim(`  ${sessionId || "（未创建）"}\n`));
      return;
    }
    if (line === "/new") {
      observer?.close();
      observer = null;
      sessionId = "";
      try { fs.unlinkSync(SESSION_FILE); } catch {}
      OUT(dim("  已切到新会话\n"));
      return;
    }
    if (line.startsWith("/model")) {
      const arg = line.slice(6).trim();
      try {
        const id = await ensureSession();
        if (!observer) subscribe(id);
        if (arg.length === 0) {
          let models = [];
          try {
            const catalog = await client.call("session/modelCatalog", { request: { address: { kind: "session", sessionId: id } } });
            const groups = catalog?.providers ?? catalog?.groups ?? catalog ?? {};
            for (const [provider, entry] of Object.entries(groups)) {
              const list = Array.isArray(entry?.models) ? entry.models : Array.isArray(entry) ? entry : [];
              for (const item of list) {
                const name = typeof item === "string" ? item : item?.id ?? item?.model;
                if (name) models.push({ provider, model: name });
              }
            }
          } catch { /* 目录不可用时用已知列表 */ }
          if (models.length === 0) models = [{ provider: currentProvider, model: "deepseek-flash" }, { provider: currentProvider, model: "deepseek-v4-pro" }];
          OUT("\n");
          for (const item of models) {
            const mark = item.model === currentModel ? blue("●") : dim("○");
            OUT(`  ${mark} ${item.model} ${dim("(" + item.provider + ")")}\n`);
          }
          OUT(dim(`\n  切换：/model <名字>\n\n`));
        } else {
          const target = arg;
          await client.call("session/selectModel", { request: { sessionId: id, provider: currentProvider, model: target, reasoningEffort: currentEffort } });
          currentModel = target;
          OUT(dim(`  模型已切换：${target}（思考 ${currentEffort}）\n`));
        }
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (line.startsWith("/think")) {
      const arg = line.slice(6).trim().toLowerCase();
      try {
        if (!EFFORT_LEVELS.includes(arg)) {
          OUT(dim(`  当前思考深度：${currentEffort}\n  可选：${EFFORT_LEVELS.join(" | ")}\n`));
          return;
        }
        const id = await ensureSession();
        if (!observer) subscribe(id);
        await client.call("session/selectModel", { request: { sessionId: id, provider: currentProvider, model: currentModel, reasoningEffort: arg } });
        currentEffort = arg;
        OUT(dim(`  思考深度已设为：${arg}\n`));
      } catch (error) {
        const msg = String(error.message || error);
        if (/does not support reasoning effort/i.test(msg)) {
          const supported = (msg.match(/support reasoning effort "?([a-z, |]+)"?/i) || [])[1];
          OUT(`  ${red("×")} ${red(`该模型不支持 ${arg}${supported ? "，可选：" + supported : ""}`)}\n`);
        } else {
          OUT(`  ${red("×")} ${red(msg)}\n`);
        }
      }
      return;
    }
    if (line === "/usage") {
      try {
        const value = await client.call("session/list", { _request: {} });
        const items = (value?.items || []).filter((i) => !i.blank);
        const pick = (i) => i.projections?.values?.tokenUsage || {};
        const current = items.find((i) => i.sessionId === sessionId);
        const sum = (key) => items.reduce((acc, i) => acc + (pick(i)[key] || 0), 0);
        const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
        OUT("\n");
        if (current) {
          const t = pick(current);
          OUT(`  ${bold("当前会话")} ${dim(current.sessionId.slice(0, 20))}\n`);
          OUT(`    ${dim("输入")} ${fmt(t.uncachedInputTokens || 0)}   ${dim("输出")} ${fmt(t.outputTokens || 0)}   ${dim("缓存读")} ${fmt(t.cacheReadTokens || 0)}   ${dim("缓存写")} ${fmt(t.cacheWriteTokens || 0)}\n`);
        } else {
          OUT(dim("  （当前还没有会话）\n"));
        }
        OUT(`  ${bold("全部")} ${dim(items.length + " 个会话")}\n`);
        OUT(`    ${dim("输入")} ${fmt(sum("uncachedInputTokens"))}   ${dim("输出")} ${fmt(sum("outputTokens"))}   ${dim("缓存读")} ${fmt(sum("cacheReadTokens"))}\n`);
        OUT("\n");
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (line === "/plugins") {
      try {
        const profileDirs = fs.readdirSync(path.join(HOME, "profiles"));
        OUT("\n");
        for (const name of profileDirs) {
          const pkgPath = path.join(HOME, "profiles", name, "package.json");
          if (!fs.existsSync(pkgPath)) continue;
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          const bundles = pkg?.dsh?.profile?.bundles || [];
          const deps = Object.keys(pkg.dependencies || {});
          const loaded = name === "web" ? blue("●") : dim("○");
          OUT(`  ${loaded} ${bold(name)} ${dim("bundle " + bundles.length + " · 依赖 " + deps.length)}\n`);
          for (const b of bundles) OUT(`      ${dim(b)}\n`);
          for (const d of deps) if (!bundles.includes(d)) OUT(`      ${dim(d)} ${dim("(npm)")}\n`);
        }
        OUT(dim("\n  安装/卸载走 dsh plugin --profile <name> add|remove <包名>\n\n"));
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (line === "/tasks") {
      try {
        const value = await client.call("schedule/list", { request: {} });
        const items = value?.items || [];
        OUT("\n");
        if (items.length === 0) OUT(dim("  （没有定时任务）\n"));
        for (const task of items) {
          const when = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—";
          const state = task.enabled === false ? dim("停用") : blue("启用");
          OUT(`  ${state} ${bold(String(task.name || task.id || "task").slice(0, 26))}  ${dim(when)}\n`);
          if (task.prompt) OUT(`      ${dim(String(task.prompt).slice(0, 50))}\n`);
        }
        OUT(dim(`\n  共 ${value?.total ?? items.length} 条\n\n`));
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (line.startsWith("/rename")) {
      const title = line.slice(7).trim();
      if (title.length === 0) {
        OUT(dim("  用法：/rename <标题>\n"));
        return;
      }
      try {
        const id = await ensureSession();
        await client.call("session/rename", { request: { sessionId: id, title } });
        OUT(dim(`  已重命名：${title}\n`));
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (line === "/fork") {
      if (!sessionId) {
        OUT(dim("  当前没有会话可分叉\n"));
        return;
      }
      try {
        const value = await client.call("session/fork", { request: { sessionId } });
        const next = value?.sessionId;
        if (!next) throw new Error("分叉没有返回新会话");
        observer?.close();
        observer = null;
        sessionId = next;
        try { fs.writeFileSync(SESSION_FILE, sessionId); } catch {}
        OUT(dim(`  已分叉到新会话：${sessionId.slice(0, 24)}\n`));
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (line === "/skills") {
      try {
        const id = await ensureSession();
        const value = await client.call("skills/list", { request: { sessionId: id } });
        const list = value?.items || value?.skills || value || [];
        OUT("\n");
        if (list.length === 0) OUT(dim("  （没有可用 skills）\n"));
        for (const item of list) {
          const desc = String(item.description || "").replace(/\s+/g, " ").slice(0, 52);
          OUT(`  ${blue(String(item.name).padEnd(14))}${dim(desc)}\n`);
        }
        OUT("\n");
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (line === "/resume") {
      try {
        const value = await client.call("session/list", { _request: {} });
        const items = (value?.items || []).filter((item) => !item.blank).slice(0, 12);
        if (items.length === 0) {
          OUT(dim("  没有历史会话\n"));
          return;
        }
        pendingResume = items;
        OUT("\n");
        items.forEach((item, index) => {
          const title = item.projections?.values?.title || "(无标题)";
          const when = new Date(item.updatedAt || 0);
          const stamp = `${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
          const mark = item.sessionId === sessionId ? blue("●") : dim("○");
          OUT(`  ${mark} ${String(index + 1).padStart(2)}. ${dim(stamp)}  ${String(title).slice(0, 30)}\n`);
        });
        OUT(dim("\n  输入序号继续，回车取消\n\n"));
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (pendingResume !== null) {
      const pick = Number(line);
      const chosen = Number.isInteger(pick) ? pendingResume[pick - 1] : null;
      pendingResume = null;
      if (chosen === null || chosen === undefined) return;
      observer?.close();
      observer = null;
      sessionId = chosen.sessionId;
      try { fs.writeFileSync(SESSION_FILE, sessionId); } catch {}
      const title = chosen.projections?.values?.title || sessionId;
      OUT(dim(`  已载入：${String(title).slice(0, 40)}\n`));
      return;
    }
    if (line === "/team" || line.startsWith("/team ")) {
      const arg = line.slice(5).trim().toLowerCase();
      if (arg !== "on" && arg !== "off") {
        OUT(`\n  团队智能体协作：${teamEnabled ? green("已开启") : dim("关闭")}\n`);
        OUT(dim("  /team on   开启：主智能体可把子任务分派给并行成员\n"));
        OUT(dim("  /team off  关闭\n\n"));
        return;
      }
      try {
        const id = await ensureSession();
        if (!observer) subscribe(id);
        // 网关按 descriptor 校验：字段必须平铺成 {agentId, enabled}，多包一层 args 会报
        // "args fields do not match the descriptor: missing agentId, enabled"
        await client.call("agentTeams/setEnabled", { agentId: id, enabled: arg === "on" });
        teamEnabled = arg === "on";
        syncStatus();
        OUT(`  ${teamEnabled ? magenta("◈") : dim("◇")} 团队协作模式已${teamEnabled ? "开启" : "关闭"}\n`);
      } catch (error) {
        OUT(`  ${red("×")} ${red(error.message)}\n`);
      }
      return;
    }
    if (line === "/stop") {
      if (sessionId) await client.cancel(sessionId).catch(() => {});
      OUT(dim("  已请求中断\n"));
      return;
    }
    if (line.startsWith("/")) {
      const head = line.split(/\s+/)[0];
      let looksLikePath = false;
      try { looksLikePath = fs.existsSync(head); } catch { looksLikePath = false; }
      // 拖进来的绝对路径也以 / 开头，别当命令拦下来
      if (!looksLikePath && !/\s/.test(line.trim())) {
        OUT(`  ${red("×")} 未知命令 ${blue(head)}，输入 /help 查看可用命令\n`);
        return;
      }
    }
    // 输入里带上了真实文件路径（拖拽/粘贴进来的），提示一下命中了哪些
    const attached = normalizeDropped(line).filter((value) => value.includes("/") || /\.[a-z0-9]{1,5}$/i.test(value));
    if (attached.length > 0) {
      OUT(dim(`  ⇥ 附件 ${attached.length}：${attached.map((v) => v.split("/").pop()).join(", ")}\n`));
    }

    busy = true;
    turnStarted = Date.now();
    thinkStarted = 0;
    thinkingChars = 0;
    queued = 0;
    streamChars = 0;
    textLines = 0;
    OUT("\n");
    editor.setStatus(syncStatus());
    startAnim("Thinking", 0);

    try {
      const id = await ensureSession();
      if (!observer) subscribe(id);
      const finished = new Promise((resolve) => { turnDone = resolve; });
      await client.prompt(id, line);
      await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 180000))]);
    } catch (error) {
      clearSpinnerLine();
      OUT(`\n  ${red("×")} ${red(error.message)}\n`);
    } finally {
      stopAnim();
      busy = false;
      queued = 0;
      syncStatus();
      editor.flushTail();
      OUT("\n");
      editor.refresh();
    }
  }
}

main();
