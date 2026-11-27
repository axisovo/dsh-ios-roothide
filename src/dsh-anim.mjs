// dsh-anim — 状态行动画：呼吸竖条 + 扫光文字 + 定宽计时
//
// 替换掉原来"16×2 像素小鲸鱼 + 静态灰字"的写法。原写法三个问题：
//   · 16×2 采样到 16 个半块字符，缩略后是噪点，看不出是鲸鱼
//   · 220ms 跳一帧，观感是"卡"，不是"在动"
//   · 计时位数变化（0.4s → 12.4s）导致整行左右抖
// 新写法用一个字符宽做呼吸、用亮度扫光表达"活着"，宽度恒定、无噪点。
const ESC = "\x1b[";
const RESET = `${ESC}0m`;

/** 呼吸竖条：1/8 → 4/8 块，往复。 */
const RAIL = ["▏", "▎", "▍", "▌", "▍", "▎"];

/** 重绘节拍。70ms ≈ 14fps，顺滑又不至于让终端持续重绘。 */
export const TICK = 70;

const hex = (h) => {
  const n = parseInt(String(h).replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
const fg = ([r, g, b]) => `${ESC}38;2;${r};${g};${b}m`;

/**
 * 每种状态一套配色：base 是底色（要够暗才有扫光对比），
 * peak 是光晕峰值，rail 是竖条颜色。
 */
export const THEMES = {
  // 思考：冷蓝，跟 DeepSeek 主色一致
  thinking: { base: hex("#32414f"), peak: hex("#93e0ff"), rail: hex("#3f8fd0") },
  // 执行工具：琥珀（与 classifyTool 里"执行"的青色刻意区分）
  typing: { base: hex("#4a4234"), peak: hex("#ffd166"), rail: hex("#c9962a") },
  // 兜底：淡紫
  default: { base: hex("#3b3f4d"), peak: hex("#b8c0ff"), rail: hex("#6f7bd6") },
};

/**
 * 扫光文字：一段光晕从左扫到右，逐字符插值亮度。
 * 用 [...text] 拆码点，中文不会被切坏。
 */
function shimmer(text, phase, theme) {
  const chars = [...text];
  if (chars.length === 0) return "";
  const span = chars.length + 7;            // 扫过一次的周期（含两端留白）
  const center = ((phase * 0.5) % span) - 3; // -3 → len+4：左侧外进、右侧外出
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    const d = Math.abs(i - center);
    const t = Math.max(0, 1 - d / 2.6);     // 约 3 字符宽的光晕
    out += fg(mix(theme.base, theme.peak, t * t)) + chars[i];
  }
  return out + RESET;
}

/**
 * 组装一行状态：`  ▍ 思考中 ·  0.4s`
 * 计时字段 padStart(4) 定宽，行宽恒定，重绘不抖。
 */
export function statusLine({ label, elapsedMs = 0, phase = 0, kind = "thinking" }) {
  const theme = THEMES[kind] || THEMES.default;
  const pulse = 0.55 + 0.45 * Math.sin(phase / 2.2); // 竖条明暗呼吸
  const rail = fg(mix(theme.base, theme.rail, pulse)) + RAIL[phase % RAIL.length] + RESET;
  const sec = (Math.max(0, elapsedMs) / 1000).toFixed(1).padStart(4, " ");
  const tail = fg(theme.base) + `· ${sec}s` + RESET;
  return `  ${rail} ${shimmer(label, phase, theme)} ${tail}`;
}

/** 回到行首并擦除整行。 */
export const CLEAR_LINE = `\r${ESC}2K${ESC}G`;

/**
 * 把彩色调色板压成灰阶：保留明暗层次，去掉色相。
 * 用于启动横幅的大鲸鱼——原来是 24 位真彩，太抢眼。
 */
export function grayscalePalette(palette = {}, { min = 70, max = 228 } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(palette)) {
    const n = parseInt(String(value).replace("#", ""), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // 线性映射到 [min, max]，不用截断，否则最亮的几档会挤成同一个灰
    const level = Math.round(min + (lum / 255) * (max - min));
    out[key] = `#${level.toString(16).padStart(2, "0").repeat(3)}`;
  }
  return out;
}

/** 状态行：◐ Thinking… (esc to interrupt · 4s · 1.2k 字) —— 只用几何字符，不用 emoji。 */
const GLYPHS = ["◐", "◓", "◑", "◒"];

const shortCount = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "m" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const shortTime = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
};

export function activityLine({ verb = "Thinking", elapsedMs = 0, tokens = 0, phase = 0, hint = "esc to interrupt" }) {
  const theme = THEMES.thinking;
  const glyph = GLYPHS[phase % GLYPHS.length];
  const meta = [hint, shortTime(elapsedMs)];
  if (tokens > 0) meta.push(`${shortCount(tokens)} 字`);
  return `  ${fg(theme.rail)}${glyph}${RESET} ${shimmer(`${verb}\u2026`, phase, theme)} ${fg(theme.base)}(${meta.join(" \u00b7 ")})${RESET}`;
}
