// dsh-diff — 行级 diff 模型（纯计算，方便单测）
//
// 只做一件事：把 old/new 两段文本对齐成带行号的 row 列表，
// 渲染交给调用方，这样颜色/宽度策略都能在 TUI 里统一处理。

/** 最长公共子序列骨架（行数不多，DP 足够；超限退化成整块替换）。 */
function lcsLength(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * 对齐两段文本。
 * @returns {Array<{type:"ctx"|"del"|"add", text:string}>}
 */
export function alignLines(oldText, newText) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  if (a.length * b.length > 60000) {
    // 太大就退化成"整块删除 + 整块新增"，不做对齐
    return [...a.map((text) => ({ type: "del", text })), ...b.map((text) => ({ type: "add", text }))];
  }
  const dp = lcsLength(a, b);
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { rows.push({ type: "ctx", text: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: "del", text: a[i] }); i += 1; }
    else { rows.push({ type: "add", text: b[j] }); j += 1; }
  }
  while (i < a.length) { rows.push({ type: "del", text: a[i] }); i += 1; }
  while (j < b.length) { rows.push({ type: "add", text: b[j] }); j += 1; }
  return rows;
}

/**
 * 把 diff 行配上"文件里的真实行号"。
 * del 用旧行号，add 用新行号，ctx 两者相同。
 */
export function withLineNumbers(rows, startLine = 1) {
  let oldNo = startLine;
  let newNo = startLine;
  return rows.map((row) => {
    const entry = { ...row };
    if (row.type === "del") { entry.oldNo = oldNo; oldNo += 1; }
    else if (row.type === "add") { entry.newNo = newNo; newNo += 1; }
    else { entry.oldNo = oldNo; entry.newNo = newNo; oldNo += 1; newNo += 1; }
    entry.no = row.type === "del" ? entry.oldNo : entry.newNo;
    return entry;
  });
}

/** 只保留"有改动"附近的行（前后各 context 行）。 */
export function trimContext(rows, context = 2) {
  const keep = new Set();
  rows.forEach((row, index) => {
    if (row.type === "ctx") return;
    for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k += 1) keep.add(k);
  });
  if (keep.size === 0) return [];
  const out = [];
  let last = -2;
  for (const index of [...keep].sort((x, y) => x - y)) {
    if (index > last + 1) out.push({ type: "gap", text: "⋯" });
    out.push(rows[index]);
    last = index;
  }
  return out;
}

export function diffStats(rows) {
  let additions = 0;
  let removals = 0;
  for (const row of rows) {
    if (row.type === "add") additions += 1;
    else if (row.type === "del") removals += 1;
  }
  return { additions, removals };
}
