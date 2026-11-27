#!/usr/bin/env node
// upload.mjs — 把当前项目推到 GitHub，不依赖 git / curl。
//
//   GITHUB_TOKEN=ghp_xxx node scripts/upload.mjs                # 仓库名 = 目录名，public
//   GITHUB_TOKEN=ghp_xxx node scripts/upload.mjs my-repo private
//   node scripts/upload.mjs --dry-run                           # 只列文件与计划
//
// 走 Git Data API：blob → tree → commit → 更新 ref。
// 令牌只从环境变量读，不会写进任何文件。
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";

const IGNORE_DIRS = new Set([".git", "node_modules", ".reghome", "scratch", "dist", ".build"]);
const IGNORE_FILES = [/\.log$/, /^\.DS_Store$/, /\.bak$/, /\.bak-/, /^\.reghome$/, /^\.smoke\.out$/, /^\.resume\.out$/];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
/** 默认仓库名：优先 package.json 里的 repository 地址，其次目录名。 */
function defaultRepoName() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const url = pkg.repository?.url || pkg.homepage || "";
    const hit = url.match(/github\.com\/[^/]+\/([^/.#]+)/);
    if (hit) return hit[1];
  } catch { /* 读不到就用目录名 */ }
  return path.basename(ROOT);
}
const REPO = positional[0] || defaultRepoName();
const VISIBILITY = positional[1] === "private" ? "private" : "public";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const log = (msg) => process.stdout.write(`\u001b[36m▸\u001b[0m ${msg}\n`);
const fail = (msg) => { process.stderr.write(`\u001b[31m×\u001b[0m ${msg}\n`); process.exit(1); };

/** 递归收集要上传的文件（按 .gitignore 精神过滤）。 */
function collect(dir = ROOT, base = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && ![".gitignore", ".github"].includes(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...collect(path.join(dir, entry.name), rel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (IGNORE_FILES.some((re) => re.test(entry.name))) continue;
    if (entry.name.endsWith(".out") || entry.name.endsWith(".plist")) continue;
    out.push(rel);
  }
  return out;
}

/**
 * 用 node:https 而不是 fetch —— 部分环境（如无 JIT 的 iOS）全局 fetch 需要额外 shim，
 * https 模块则是稳的。
 */
function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = https.request(
      {
        hostname: "api.github.com",
        path: pathname,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "dsh-ios-roothide-uploader",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(pathname, init = {}) {
  return request(init.method || "GET", `${API}${pathname}`, init.body || null);
}

const files = collect();
if (files.length === 0) fail("没有找到要上传的文件");
log(`仓库：${REPO}（${VISIBILITY}）`);
log(`文件：${files.length} 个，共 ${(files.reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0) / 1024).toFixed(0)} KB`);

if (dryRun) {
  for (const file of files) process.stdout.write(`   ${file}\n`);
  log("dry-run：未发起任何请求");
  process.exit(0);
}

if (!TOKEN) fail("缺少 GITHUB_TOKEN 环境变量（需 repo 权限）");

const me = await api("/user");
if (me.status !== 200) fail(`取用户信息失败（HTTP ${me.status}）：${me.body?.message || ""}`);
const owner = me.body.login;
log(`身份：${owner}`);

let repoInfo = await api(`/repos/${owner}/${REPO}`);
if (repoInfo.status === 404) {
  log(`创建仓库 ${owner}/${REPO}`);
  const created = await api("/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: REPO,
      description: "Terminal client for DeepSeek Harness — streaming, inline diffs, queue/steer input.",
      private: VISIBILITY === "private",
      has_issues: true,
      has_wiki: false,
    }),
  });
  if (created.status !== 201) fail(`创建仓库失败（HTTP ${created.status}）：${created.body?.message || ""}`);
  repoInfo = created;
} else if (repoInfo.status === 200) {
  log("仓库已存在，追加一次提交");
} else {
  fail(`查询仓库失败（HTTP ${repoInfo.status}）：${repoInfo.body?.message || ""}`);
}

const BRANCH = repoInfo.body?.default_branch || "main";

// 现有分支头（新建仓库时为空）
let headRef = await api(`/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`);
let parentSha = headRef.status === 200 ? headRef.body.object.sha : null;

if (!parentSha) {
  // 空仓库不接受 Git Data API 的 blob 上传（409 Git Repository is empty），
  // 先用 Contents API 落一个提交把仓库"点亮"，之后就能走 tree/commit 一次推完。
  log("初始化仓库（Contents API 建首个提交）");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"));
  const boot = await api(`/repos/${owner}/${REPO}/contents/README.md`, {
    method: "PUT",
    body: JSON.stringify({ message: "chore: 初始化仓库", content: readme.toString("base64") }),
  });
  if (boot.status !== 201 && boot.status !== 200) {
    fail(`初始化失败（HTTP ${boot.status}）：${boot.body?.message || ""}`);
  }
  headRef = await api(`/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`);
  parentSha = headRef.status === 200 ? headRef.body.object.sha : null;
  if (!parentSha) fail("初始化后仍拿不到分支头");
}

log("上传文件（blob）");
const tree = [];
for (const file of files) {
  const content = fs.readFileSync(path.join(ROOT, file));
  const blob = await api(`/repos/${owner}/${REPO}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }),
  });
  if (blob.status !== 201) {
    const msg = blob.body?.message || "";
    // 没有 workflow 作用域的令牌不能写 .github/workflows/*，跳过而不是整体失败
    if (/workflow/i.test(msg) && file.startsWith(".github/workflows/")) {
      process.stdout.write(`   \u001b[33m!\u001b[0m 跳过 ${file}（令牌缺 workflow 作用域）\n`);
      continue;
    }
    fail(`上传 ${file} 失败（HTTP ${blob.status}）：${msg}`);
  }
  tree.push({ path: file, mode: "100644", type: "blob", sha: blob.body.sha });
  process.stdout.write(`   ${file}\n`);
}

log("生成 tree");
const newTree = await api(`/repos/${owner}/${REPO}/git/trees`, {
  method: "POST",
  body: JSON.stringify({ tree }),
});
if (newTree.status !== 201) fail(`创建 tree 失败（HTTP ${newTree.status}）`);

log("创建 commit");
const commit = await api(`/repos/${owner}/${REPO}/git/commits`, {
  method: "POST",
  body: JSON.stringify({
    message: `feat: ${REPO} — 终端客户端（首版）\n\n由 scripts/upload.mjs 推送`,
    tree: newTree.body.sha,
    parents: parentSha ? [parentSha] : [],
  }),
});
if (commit.status !== 201) fail(`创建 commit 失败（HTTP ${commit.status}）`);

if (parentSha) {
  const updated = await api(`/repos/${owner}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.body.sha, force: true }),
  });
  if (updated.status !== 200) fail(`更新分支失败（HTTP ${updated.status}）`);
} else {
  const created = await api(`/repos/${owner}/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: "refs/heads/main", sha: commit.body.sha }),
  });
  if (created.status !== 201) fail(`创建分支失败（HTTP ${created.status}）`);
}

log(`完成：https://github.com/${owner}/${REPO}`);
