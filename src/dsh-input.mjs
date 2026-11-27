// dsh-input — 自己管光标的行编辑器
//
// 为什么不用 node:readline：
//   · readline 的 prompt 一旦超过一行（换行 / 长输入 / 菜单），它内部的"光标在第几行"
//     记录就和真实终端对不上，我们再往里写 \r\x1b[2K 就会擦错行，表现为"换一行又多重复显示一行"
//   · readline 也没有"输出插到输入区上方"的接口，只能 pause/resume，于是 busy 时就无法输入
// 这里的模型很简单：
//   · 屏幕底部是一块"输入区"（block），内容 = 流式尾巴 + 活动行 + 状态行 + 输入行 + 菜单
//   · 任何输出都走 print()：先把 block 整块擦掉，把完整行写进 scrollback，再重画 block
//   · 活动行动画只是不断重画 block，永远不会污染 scrollback，也不会擦错行
import readline from "node:readline";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

/** 终端显示宽度：CJK / 全角算 2 列。 */
export function charWidth(ch) {
  const c = ch.codePointAt(0);
  if (c === undefined) return 1;
  if (c === 0x0a || c === 0x0d) return 0;
  const wide = (c >= 0x1100 && c <= 0x115f)
    || (c >= 0x2e80 && c <= 0xa4cf)
    || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe6f)
    || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6)
    || (c >= 0x1f300 && c <= 0x1f64f)
    || (c >= 0x1f900 && c <= 0x1f9ff);
  return wide ? 2 : 1;
}

/** CSI 转义序列（颜色、光标移动）。它是零宽度的，绝不能参与折行计算。 */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/;

/** 把字符串拆成 token：转义序列整体是一个 token（宽度 0），其余按码点拆。 */
function tokenize(text) {
  const source = String(text);
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === "\x1b") {
      const match = ANSI_RE.exec(source.slice(i));
      if (match && match.index === 0) {
        tokens.push({ esc: match[0] });
        i += match[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(source.codePointAt(i));
    tokens.push({ ch });
    i += ch.length;
  }
  return tokens;
}


/** 按显示宽度裁剪，但保留转义序列（不能把 ESC 剪断）。 */
export function clipAnsi(text, cols) {
  const width = Math.max(1, cols | 0);
  let used = 0;
  let out = "";
  for (const token of tokenize(text)) {
    if (token.esc) { out += token.esc; continue; }
    const w = charWidth(token.ch);
    if (used + w > width) break;
    out += token.ch;
    used += w;
  }
  return out;
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export function textWidth(text) {
  let w = 0;
  for (const token of tokenize(stripAnsi(text))) w += charWidth(token.ch);
  return w;
}

/** 按显示列宽折行（ANSI 序列整体保留，不会被切断）。 */
export function wrapTo(text, cols) {
  const width = Math.max(1, cols | 0);
  const rows = [];
  let row = "";
  let used = 0;
  let sgr = ""; // 当前生效的 SGR，换行后要重新贴一次，否则续行会掉色
  const openRow = () => { row = sgr; used = 0; };
  for (const token of tokenize(text)) {
    if (token.esc) {
      row += token.esc;
      if (/m$/.test(token.esc)) sgr = /\x1b\[(?:0)?m$/.test(token.esc) ? "" : sgr + token.esc;
      continue;
    }
    if (token.ch === "\n") { rows.push(row); openRow(); continue; }
    const w = charWidth(token.ch);
    if (used + w > width) { rows.push(row); openRow(); }
    row += token.ch;
    used += w;
  }
  rows.push(row);
  return rows;
}

/**
 * 纯布局：给定各部分内容与终端列宽，算出整块文本、光标偏移、总行数。
 * 抽成纯函数是为了能脱离终端做单元测试。
 */
export function layoutBlock({ cols, prompt, line, cursor, menu = [], partial = [], activity = "", status = "" }) {
  // 留一列安全边距：块里的行一旦"刚好填满终端宽度"，终端会进入 pending-wrap，
  // 实际占两行，而这里只算一行 —— 擦除就会少擦一行，旧内容不断累积（实测重复 22 次）。
  const width = Math.max(1, cols - 1);
  const rows = [];
  let cursorRow = 0;
  let cursorCol = 0;

  // 顺序：流式尾巴 → 活动行 → 输入 → 菜单 → 状态提示
  // （尾巴和活动行紧贴输入上方，输出与输入之间不会插进别的东西）
  for (const item of partial) rows.push(...wrapTo(item, width));
  // 活动行/状态行永远单行：折行会把输入区撑高、动效跳动
  if (activity) rows.push(clipAnsi(activity, width));


  // 输入行逐字符折行，同时把光标位置一并算出来。
  // 不能只对总宽度取模：宽字符（中文）跨行时一行可能只用到 width-1 列，
  // 取模算出来的列号会和屏幕上真实位置差一列 —— 光标就是从这里开始错位的。
  // prompt 可能带颜色（blue("❯ ")），所以按 token 走：转义零宽、可见字符才计数
  const cursorIndex = [...stripAnsi(prompt)].length + cursor;
  const inputRows = [];
  let rowText = "";
  let used = 0;
  let seen = 0;
  let localRow = 0;
  let localCol = 0;
  for (const token of tokenize(prompt + line)) {
    if (token.esc) { rowText += token.esc; continue; }
    const w = charWidth(token.ch);
    if (used + w > width) { inputRows.push(rowText); rowText = ""; used = 0; }
    if (seen === cursorIndex) { localRow = inputRows.length; localCol = used; }
    rowText += token.ch;
    used += w;
    seen += 1;
  }
  if (seen === cursorIndex) { localRow = inputRows.length; localCol = used; }
  inputRows.push(rowText);
  // 行刚好写满时，光标在逻辑上已落在下一行的第 0 列。
  // 不补这一行的话光标列号会等于 width，终端会把它显示到上一行末尾（看起来"错了"）。
  if (localCol >= width) { localRow += 1; localCol = 0; inputRows.push(""); }
  cursorRow = rows.length + localRow;
  cursorCol = localCol;

  rows.push(...inputRows);
  for (const item of menu) rows.push(...wrapTo(item, width));
  if (status) rows.push(clipAnsi(status, width));

  return { rows, cursorRow, cursorCol, height: rows.length };
}

export class LineEditor {
  constructor({ stdin = process.stdin, stdout = process.stdout, prompt = "❯ ", onSubmit = () => {}, onKey = () => {}, history = [] } = {}) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.prompt = prompt;
    this.onSubmit = onSubmit;
    this.onKey = onKey;
    this.history = history;
    this.historyIndex = -1;

    this.line = "";
    this.cursor = 0;
    this.menu = [];
    this.partial = [];      // 未结束的流式尾行
    this.activity = "";     // 活动行（含 ANSI）
    this.status = "";       // 状态行（含 ANSI）
    this.blockRows = 0;
    this.blockCursorRow = 0;
    this.tailOwned = false;
    this.running = false;
    this._lastRender = "";
  }

  start() {
    if (this.running) return;
    this.running = true;
    readline.emitKeypressEvents(this.stdin);
    this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this._onKeypress = (ch, key) => this.#keypress(ch, key);
    this.stdin.on("keypress", this._onKeypress);
    this._onResize = () => this.render(true);
    this.stdout.on?.("resize", this._onResize);
    this.render(true);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.stdin.off?.("keypress", this._onKeypress);
    this.stdin.setRawMode?.(false);
    this.#eraseBlock();
    this.stdout.write(`${ESC}?25h`);
  }

  setPrompt(prompt) { this.prompt = prompt; this.render(); }
  setMenu(rows) { this.menu = rows; this.render(); }
  setActivity(text) { if (this.activity !== text) { this.activity = text; this.render(); } }
  setStatus(text) { if (this.status !== text) { this.status = text; this.render(); } }
  setLine(text) { this.line = text; this.cursor = text.length; this.render(); }
  /** 在光标处插入一段文本（粘贴/拖拽路径用）。 */
  insertText(text) { this.#insert(text); }
  clearInput() { this.line = ""; this.cursor = 0; }

  refresh() { this.render(); }

  /**
   * 输出：可以被调用任意多次、任意时机。
   * 完整行写进 scrollback 永久保留，剩下的半行作为"尾巴"留在输入区里继续长大。
   */
  print(text) {
    const source = String(text ?? "");
    if (source.length === 0) return;
    this.#eraseBlock();
    const parts = source.split("\n");
    const tail = parts.pop();
    // 残行是 setTail 维护的"正在长的那一行"的临时显示。
    // 一旦有完整行落盘，旧残行必须丢弃，否则它会被当成正文再写一遍 —— 正文成对重复就是这么来的。
    if (parts.length > 0 && this.tailOwned) { this.partial = []; this.tailOwned = false; }
    if (parts.length > 0) this.stdout.write(parts.join("\n") + "\n");
    if (tail.length > 0) {
      // 半行继续接在上一段尾巴后面（流式 token 就是一滴滴来的）
      if (this.partial.length > 0) this.partial[this.partial.length - 1] += tail;
      else this.partial.push(tail);
    }
    this.#trimPartial();
    this.render(true);
  }

  /** 覆盖（而不是追加）尾巴：流式文本每帧都会把整段当前行重画一遍。 */
  setTail(text) {
    const value = String(text ?? "");
    if (this.partial.length === 1 && this.partial[0] === value) return;
    this.partial = value.length > 0 ? [value] : [];
    this.tailOwned = value.length > 0;
    this.render(true);
  }

  /** 把尾巴正式写进 scrollback（换行收尾）。 */
  flushTail() {
    if (this.partial.length === 0) return;
    const text = this.partial.join("\n");
    this.partial = [];
    this.tailOwned = false;
    this.#eraseBlock();
    this.stdout.write(text + "\n");
    this.render(true);
  }

  /** 直接把一段完整内容打进 scrollback（不当作尾巴）。 */
  printLine(text) { this.print(`${text}\n`); }

  clearScreen() {
    this.#eraseBlock();
    this.stdout.write(`${ESC}2J${ESC}H`);
    this.render(true);
  }

  #trimPartial() {
    const cols = this.stdout.columns || 80;
    const limit = 8; // 尾巴最多占 8 行，多了就从上面丢掉（滚动感）
    const rows = this.partial.join("\n");
    const wrapped = wrapTo(rows, cols);
    if (wrapped.length > limit) {
      const kept = wrapped.slice(-limit).join("").length;
      let acc = "";
      const joined = rows.split("");
      for (const ch of joined) {
        acc += ch;
        if (textWidth(acc) >= kept) break;
      }
      this.partial = [acc];
    }
  }

  #eraseBlock() {
    if (this.blockRows <= 0) return;
    // 光标此刻就停在 block 的第 blockCursorRow 行，回到块首只需上移这么多。
    // （之前按"光标在最后一行"算，一旦输入折行就会擦不完，旧块留在屏幕上 → 重复显示）
    const up = this.blockCursorRow;
    if (up > 0) this.stdout.write(`${ESC}${up}A`);
    this.stdout.write(`\r${ESC}0J`);
    this.blockRows = 0;
    this.blockCursorRow = 0;
  }

  render(force = false) {
    if (!this.running) {
      // 尚未 start 时只把内容排队，等 start 一次画出来
      return;
    }
    const cols = this.stdout.columns || 80;
    const layout = layoutBlock({
      cols,
      prompt: this.prompt,
      line: this.line,
      cursor: this.cursor,
      menu: this.menu,
      partial: this.partial,
      activity: this.activity,
      status: this.status,
    });
    const body = layout.rows.join("\n");
    if (!force && body === this._lastRender) return;
    this._lastRender = body;

    this.#eraseBlock();
    this.stdout.write(`${ESC}?25l`);
    this.stdout.write(body);
    const below = layout.height - 1 - layout.cursorRow;
    if (below > 0) this.stdout.write(`${ESC}${below}A`);
    this.stdout.write("\r");
    if (layout.cursorCol > 0) this.stdout.write(`${ESC}${layout.cursorCol}C`);
    this.stdout.write(`${ESC}?25h`);
    this.blockRows = layout.height;
    this.blockCursorRow = layout.cursorRow;
  }

  #setLineFromHistory(step) {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) this.historyIndex = this.history.length;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + step));
    this.line = this.history[this.historyIndex] ?? "";
    this.cursor = this.line.length;
    this.render();
  }

  #insert(rawText) {
    // 终端可能把整段粘贴作为一大块字符送进来，也可能带 bracketed-paste 包裹
    const text = String(rawText).replace(/\x1b\[20[01]~/g, "");
    if (text.length === 0) return;
    const chars = [...this.line];
    const at = [...chars.slice(0, this.cursor).join("")].length;
    const head = [...this.line].slice(0, at).join("");
    const tail = [...this.line].slice(at).join("");
    this.line = head + text + tail;
    this.cursor = [...(head + text)].length;
    this.render();
  }

  #keypress(ch, key = {}) {
    const name = key.name;
    const ctrl = key.ctrl || key.meta && key.name === "m";
    const consumed = this.onKey?.(ch, key, this);
    if (consumed) return;

    if (key.ctrl && name === "c") {
      if (this.line.length > 0) { this.clearInput(); this.render(); return; }
      this.onCancel?.();
      return;
    }
    if (key.ctrl && name === "d") {
      if (this.line.length === 0) { this.onExit?.(); return; }
    }
    if (name === "return" || name === "enter") {
      const text = this.line;
      if (key.meta) { // Alt+Enter：插入模式，不打断当前回合
        this.onAltEnter?.(text);
      } else {
        this.clearInput();
        this.render();
        this.onSubmit?.(text);
        return;
      }
      this.line = "";
      this.cursor = 0;
      this.render();
      return;
    }
    if (name === "escape") { this.onEscape?.(); return; }
    if (name === "backspace") {
      if (this.cursor > 0) {
        const chars = [...this.line];
        chars.splice(this.cursor - 1, 1);
        this.line = chars.join("");
        this.cursor -= 1;
        this.render();
      }
      return;
    }
    if (name === "delete") {
      const chars = [...this.line];
      chars.splice(this.cursor, 1);
      this.line = chars.join("");
      this.render();
      return;
    }
    if (name === "left") { this.cursor = Math.max(0, this.cursor - 1); this.render(); return; }
    if (name === "right") { this.cursor = Math.min([...this.line].length, this.cursor + 1); this.render(); return; }
    if (name === "home" || (key.ctrl && name === "a")) { this.cursor = 0; this.render(); return; }
    if (name === "end" || (key.ctrl && name === "e")) { this.cursor = [...this.line].length; this.render(); return; }
    if (key.ctrl && name === "u") { this.clearInput(); this.render(); return; }
    if (key.ctrl && name === "k") {
      const chars = [...this.line];
      this.line = chars.slice(0, this.cursor).join("");
      this.render();
      return;
    }
    if (key.ctrl && name === "w") {
      const chars = [...this.line];
      let i = this.cursor;
      while (i > 0 && /\s/.test(chars[i - 1])) i -= 1;
      while (i > 0 && !/\s/.test(chars[i - 1])) i -= 1;
      chars.splice(i, this.cursor - i);
      this.line = chars.join("");
      this.cursor = i;
      this.render();
      return;
    }
    if (name === "up") { this.#setLineFromHistory(-1); return; }
    if (name === "down") { this.#setLineFromHistory(1); return; }
    if (name === "tab") { this.onTab?.(); return; }
    if (ch && !key.ctrl && !key.meta) {
      // 多字符一次性到达 = 粘贴/拖拽，交给上层决定要不要当文件路径处理
      if ([...ch].length > 1 && typeof this.onPaste === "function") {
        this.onPaste(ch);
        return;
      }
      this.#insert(ch);
      void ctrl;
    }
  }
}
