#!/usr/bin/env node
// ds — DeepSeek Harness 的终端客户端入口
//
// 不带参数直接进交互界面。参数只做两件轻量的事，不启动 TUI：
//   ds --help     打印用法
//   ds --version  打印版本
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const args = new Set(process.argv.slice(2));

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")); } catch { return {}; }
})();

if (args.has("--version") || args.has("-v")) {
  process.stdout.write(`${pkg.name || "dsh-cli"} ${pkg.version || "0.0.0"}\n`);
  process.exit(0);
}

if (args.has("--help") || args.has("-h")) {
  process.stdout.write(`
${pkg.name || "dsh-cli"} ${pkg.version || ""} — DeepSeek Harness 终端客户端

用法
  ds                  进入交互界面（连接本机 dsh web）
  ds --help           显示本帮助
  ds --version        显示版本

环境变量
  DSH_HOME            dsh 数据目录，需含 .launch-token（默认 ~/.dsh）
  DSH_PORT            dsh web 端口（默认 3081）
  DSH_WS_MODULE       ws 模块路径（iOS 上指向 dsh 自带的纯 JS 副本）
  DSH_WHALE_ASSET     可选：启动横幅的鲸鱼像素素材 frames.json

界面上输入 / 查看全部命令（/help /model /think /team /usage /resume /stop …）。
`);
  process.exit(0);
}

await import(path.join(ROOT, "src", "dsh-live.mjs"));
