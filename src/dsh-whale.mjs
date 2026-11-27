// dsh-whale — 把 42×30 的像素鲸鱼渲染成终端半块字符
//
// 旧做法是"最近邻采样到 21×12 再两行并一行"，形状全糊成噪点。
// 这里改成面积平均：每个输出格覆盖源图一块矩形，按覆盖率加权算亮度，
// 边缘用 alpha 混合淡出，于是缩到 24×9 还能看出鲸鱼的轮廓。

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const luminance = (hex) => {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
};

/**
 * @returns {{lum:number, alpha:number}[][]} 采样网格（行×列）
 */
export function sampleWhale(rows, palette, cols, outRows) {
  const H = rows.length;
  const W = rows[0]?.length ?? 0;
  const cache = new Map();
  const lumOf = (key) => {
    if (key === "." || key === undefined) return null;
    if (!cache.has(key)) cache.set(key, palette[key] ? luminance(palette[key]) : null);
    return cache.get(key);
  };
  const grid = [];
  for (let y = 0; y < outRows; y += 1) {
    const line = [];
    for (let x = 0; x < cols; x += 1) {
      const x0 = Math.floor((x * W) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / cols));
      const y0 = Math.floor((y * H) / outRows);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / outRows));
      let sum = 0;
      let cover = 0;
      let total = 0;
      for (let yy = y0; yy < y1 && yy < H; yy += 1) {
        for (let xx = x0; xx < x1 && xx < W; xx += 1) {
          total += 1;
          const value = lumOf(rows[yy][xx]);
          if (value !== null) { sum += value; cover += 1; }
        }
      }
      line.push({ alpha: total > 0 ? cover / total : 0, lum: cover > 0 ? sum / cover : 0 });
    }
    grid.push(line);
  }
  return grid;
}

/**
 * 渲染成半块字符行。
 * @param {{rows:string[], palette:Record<string,string>, cols?:number, outRows?:number, min?:number, max?:number}} options
 * @returns {string[]} 每行一个字符串（含 ANSI）
 */
export function renderWhale({ rows, palette, cols = 24, outRows = 9, min = 72, max = 232 } = {}) {
  if (!rows || rows.length === 0) return [];
  const grid = sampleWhale(rows, palette, cols, outRows * 2);
  const shade = (cell) => {
    if (!cell || cell.alpha < 0.3) return null;
    // 按覆盖率把亮度压向黑，边缘就不会出现一圈硬边
    const value = cell.lum * Math.min(1, cell.alpha * 1.15);
    const level = Math.round(min + (value / 255) * (max - min) * (0.55 + 0.45 * cell.alpha));
    return Math.max(min, Math.min(max, level));
  };
  const lines = [];
  for (let y = 0; y < outRows; y += 1) {
    const top = grid[y * 2] || [];
    const bottom = grid[y * 2 + 1] || [];
    let line = "";
    for (let x = 0; x < cols; x += 1) {
      const t = shade(top[x]);
      const b = shade(bottom[x]);
      if (t === null && b === null) { line += " "; continue; }
      let prefix = "";
      if (t !== null) prefix += `${ESC}38;2;${t};${t};${t}m`;
      if (b !== null) prefix += `${ESC}48;2;${b};${b};${b}m`;
      line += prefix + "▀" + RESET;
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}
