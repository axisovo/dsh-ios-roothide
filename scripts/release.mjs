#!/usr/bin/env node
// release.mjs — 打 tag + 建 GitHub Release（让仓库页出现 Releases 区块与最新版徽章）
//
//   GITHUB_TOKEN=ghp_xxx node scripts/release.mjs            # 版本取 package.json
//   GITHUB_TOKEN=ghp_xxx node scripts/release.mjs v0.2.0
//   node scripts/release.mjs --dry-run
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";
const OWNER = process.env.GITHUB_OWNER || "axisovo";
const REPO = process.env.GITHUB_REPO || "dsh-ios-roothide";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = args.find((a) => !a.startsWith("--")) || `v${pkg.version}`;
const tag = version.startsWith("v") ? version : `v${version}`;

const log = (m) => process.stdout.write(`\u001b[36m▸\u001b[0m ${m}\n`);
const fail = (m) => { process.stderr.write(`\u001b[31m×\u001b[0m ${m}\n`); process.exit(1); };

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = https.request({
      hostname: "api.github.com",
      path: pathname,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dsh-ios-roothide-release",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const body = `## dsh-ios-roothide ${tag}

DeepSeek Harness 的终端客户端（仓库：dsh-ios-roothide）。**主战场：iOS 16.3 + RootHide 越狱（rootless）**，同源代码在 macOS / Linux 上照常运行。

### 环境

- iOS 16.3，RootHide 越狱（rootless，\`/var/jb\`），iPhone SE 2（A13，3 GB）
- Node **v24.21.0 \`--jitless\`**（无 JIT，依赖全走纯 JS）
- 服务端 \`dsh web\` 0.2.2-rc.5 @ \`127.0.0.1:3081\`
- 兼容 macOS / Linux / WSL，Node ≥ 18

### 支持范围

- **双端**：web 端（浏览器）直接可用；**cli 端（本项目）需要在 \`newteam\` 中唤起**
- **插件**：已测试支持 \`dsh-purge-lingjia\`（破甲）；**其他插件未做测试**，能加载但不保证渲染与交互正确

### 功能

- 常驻连接零冷启动，每轮 2–4 秒
- 逐 token 流式输出，思考可见并在结束后收敛
- \`● Tool(args)\` / \`└ result\` 卡片式工具行
- 改文件时显示带行号的内联 diff 面板
- 任务运行中仍可输入：\`Enter\` 排队、\`Alt+Enter\` 插入、\`Esc\` 中断
- 离开终端再回来，能恢复正在跑的回合与最终结果
- 拖拽文件把路径放进输入框；\`/team on\` 切换团队智能体协作
- 图标只用几何字符与色块，避免 iOS 终端把符号渲染成 emoji

### 验证方式

\`pty.fork()\` 起伪终端 → 喂指令 → 抓全部输出字节 → 最小 ANSI 模拟器回放核对排版。
`;

if (dryRun) {
  log(`将创建标签 ${tag} 与 Release（dry-run）`);
  log(`Release 正文 ${body.length} 字节`);
  process.exit(0);
}
if (!TOKEN) fail("缺少 GITHUB_TOKEN");

log(`仓库 ${OWNER}/${REPO}，版本 ${tag}`);

const head = await request("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
if (head.status !== 200) fail(`取分支头失败（HTTP ${head.status}）`);
const sha = head.body.object.sha;

const exists = await request("GET", `/repos/${OWNER}/${REPO}/git/ref/tags/${tag}`);
if (exists.status !== 200) {
  log(`创建标签 ${tag} → ${sha.slice(0, 7)}`);
  const created = await request("POST", `/repos/${OWNER}/${REPO}/git/refs`, JSON.stringify({ ref: `refs/tags/${tag}`, sha }));
  if (created.status !== 201) fail(`建标签失败（HTTP ${created.status}）：${created.body?.message || ""}`);
} else {
  log(`标签 ${tag} 已存在`);
}

const released = await request("POST", `/repos/${OWNER}/${REPO}/releases`, JSON.stringify({
  tag_name: tag,
  name: `${tag} — iOS RootHide 越狱版`,
  body,
  draft: false,
  prerelease: false,
}));
if (released.status === 422 && /already_exists/i.test(released.body?.message || "")) {
  log("该版本 Release 已存在，跳过");
} else if (released.status !== 201) {
  fail(`创建 Release 失败（HTTP ${released.status}）：${released.body?.message || ""}`);
} else {
  log(`完成：${released.body.html_url}`);
}
