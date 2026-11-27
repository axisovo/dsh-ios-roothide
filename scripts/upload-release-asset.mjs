#!/usr/bin/env node
// upload-release-asset.mjs — 把 .deb 挂到最新 Release 上
//
//   GITHUB_TOKEN=ghp_xxx node scripts/upload-release-asset.mjs dist/xxx.deb
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const OWNER = process.env.GITHUB_OWNER || "axisovo";
const REPO = process.env.GITHUB_REPO || "dsh-ios-roothide";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const file = process.argv[2];

if (!file) { process.stderr.write("用法：node scripts/upload-release-asset.mjs <文件>\n"); process.exit(1); }
if (!TOKEN) { process.stderr.write("缺少 GITHUB_TOKEN\n"); process.exit(1); }
if (!fs.existsSync(file)) { process.stderr.write(`文件不存在：${file}\n`); process.exit(1); }

const log = (m) => process.stdout.write(`\u001b[36m▸\u001b[0m ${m}\n`);

function request(host, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: pathname, method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dsh-cli-release-asset",
        "X-GitHub-Api-Version": "2022-11-28",
        ...headers,
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
    if (body) req.write(body);
    req.end();
  });
}

const latest = await request("api.github.com", "GET", `/repos/${OWNER}/${REPO}/releases/latest`);
if (latest.status !== 200) { process.stderr.write(`取最新 Release 失败：HTTP ${latest.status}\n`); process.exit(1); }
const release = latest.body;
const name = path.basename(file);
const existing = (release.assets || []).find((a) => a.name === name);
if (existing) {
  log(`已存在同名资产，先删除：${name}`);
  await request("api.github.com", "DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`);
}
const data = fs.readFileSync(file);
log(`上传 ${name}（${(data.length / 1024).toFixed(0)} KB）→ ${release.tag_name}`);
const uploaded = await request(
  "uploads.github.com", "POST",
  `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
  data,
  { "Content-Type": "application/octet-stream", "Content-Length": data.length },
);
if (uploaded.status !== 201) {
  process.stderr.write(`上传失败（HTTP ${uploaded.status}）：${uploaded.body?.message || ""}\n`);
  process.exit(1);
}
log(`完成：${uploaded.body.browser_download_url}`);
