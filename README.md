# dsh-ios-roothide — DeepSeek Harness 终端客户端（iOS RootHide 越狱 / jailbreak / rootless）

![platform](https://img.shields.io/badge/platform-iOS%20%7C%20macOS%20%7C%20Linux-blue)
![iOS](https://img.shields.io/badge/iOS-16.3-black?logo=apple)
![jailbreak](https://img.shields.io/badge/jailbreak-RootHide%20rootless-orange)
![node](https://img.shields.io/badge/node-%E2%89%A518-green?logo=nodedotjs)
![license](https://img.shields.io/github/license/axisovo/dsh-ios-roothide)
![release](https://img.shields.io/github/v/release/axisovo/dsh-ios-roothide)

> **一台越狱 iPhone 上的 DeepSeek Harness 终端客户端。**
> 主战场是 **iOS + RootHide（rootless 越狱）**：没有 JIT、有 AppGroup 路径命名空间差异、
> 终端只有 80 列——本项目就是为这种环境写的。同源代码在 macOS / Linux 上照常运行。

**双端项目**：iOS 16 Safari 适配的 **web 端** + 常驻连接的 **cli 端**（`ds`）。

- **web 端** —— 在越狱 iPhone 的 Safari 16 上跑得起来的界面（polyfill + 键盘/输入法兼容 + safari16 构建），外加**侧边栏一键重启**
- **cli 端** —— 直连同一个 `dsh web` 服务，零冷启动、逐 token 流式、内联 diff，输入 `/` 调命令

两端共用同一个会话：网页里发起的对话，`ds` 里能看到；`ds` 里跑的回合，网页刷新也在。

> 关键词：DeepSeek Harness · iOS 越狱 · RootHide · **dsh-purge-lingjia（破甲）** · web / cli 双端

```
❯ 把 src/config.js 里的 timeout 改成 30s

▪ Thought for 4s

● Read(src/config.js)
└ 42 行 · 0.1s

● Update(src/config.js)
└ Updated src/config.js · 0.2s
   ┌─ src/config.js +1 -1 ──────────────────────────────
      │ ⋯
   12│- const timeout = 10;
   12│+ const timeout = 30;
   └────────────────────────────────────────────────────

 改了超时时间，另外发现它在 3 处被引用……

▪ Worked for 12s · 3120 in / 284 out · 24 字/秒
```

## 跑在什么环境

| | |
|---|---|
| **主要目标环境** | **iOS 16.3 + RootHide 越狱（rootless，`/var/jb`）**，改机型 iPhone SE 2 (A13) |
| **运行时** | Node **v24.21.0 `--jitless`**（越狱机上没有 JIT，所以依赖全部走纯 JS） |
| **服务端** | 同机运行的 `dsh web`（`@deepseek-ai/dsh` 0.2.2-rc.5），`127.0.0.1:3081` |
| **其他可用环境** | macOS / Linux / WSL，Node ≥ 18，任意 256 色终端 |
| **终端** | 宽度 ≥ 60 列体验最佳；< 44 列不画启动横幅 |

越狱环境带来的三个特殊约束，代码里都做了适配：

1. **没有 JIT** —— 不引入原生扩展，`ws` 走纯 JS 实现
2. **路径命名空间分裂** —— `node` 看到的是 AppGroup 真实路径，shell 看到的是 `/var/mobile` 映射，所以客户端一律用 `DSH_HOME` 显式指定数据目录，从不猜
3. **越狱前缀 rootless** —— 任何写死的 `/var/mobile/Library/...` 裸路径都会让进程暴露"被越狱污染"，本项目不触碰这些位置

## 支持范围

### 双端形态

| 端 | 形态 | 本仓库提供什么 | 启动方式 |
|---|---|---|---|
| **web 端** | 浏览器界面 | ✅ **iOS 16 适配层**（polyfill / 键盘兼容 / safari16 构建 / 一键重启） | 装好适配层后启动 `dsh web`，Safari 打开端口 |
| **cli 端** | 终端界面（命令 `ds`） | ✅ 全部源码 | **需要在 `newteam` 中唤起**后再使用 |

> 两端都依赖服务端 `dsh web`：**没有 web 服务，cli 连不上，页面也打不开**。
> 先把 `dsh web` 跑起来（默认 `127.0.0.1:3081`），再用任一端连接。
>
> web 端的界面壳来自上游 `@deepseek-ai/dsh-web-frontend`；本仓库提供的是**让它在 iOS 16 上能用的那一层**，
> 以及新增的一键重启。适配层安装见下方「web 端」。

### 插件兼容

| 插件 | 状态 |
|---|---|
| **`dsh-purge-lingjia`（破甲）** | ✅ **已测试支持** |
| 其他插件 / bundle | ⚠️ **未做测试**，能加载但不保证渲染与交互正确 |

"破甲"插件的状态自检、提示词与规则管理、本机备份回滚，在 cli 端的命令与流式渲染下可以正常工作；
其余插件因为可能往会话里塞自定义事件类型，本客户端未逐一适配——遇到不渲染的事件属于预期行为，不是崩溃。

## 特性

| 能力 | 说明 |
|---|---|
| **零冷启动** | 一次认证 + 一条 WebSocket，之后每轮只发一次 RPC（2–4 秒），不重复加载插件 |
| **逐 token 流式** | 正文按 token 流出，未完成的行贴着输入框继续长 |
| **思考可见** | `◐ Thinking… (esc to interrupt · 4s · 1.2k 字)`，结束后收敛成一行 |
| **工具卡片** | `● Bash(cmd)` / `└ 结果`，一行一调用 |
| **内联 diff** | 改文件时给出带行号的对照面板，`-`/`+` 着色，改动范围一眼可见 |
| **跑着也能输入** | `Enter` 排队、`Alt+Enter` 立即插入当前回合、`Esc` 中断 |
| **拖拽文件** | 把文件拖进终端，路径自动归一化进输入框，并提示 `⇥ 附件 N` |
| **团队协作** | `/team on` 让主智能体把子任务分派给并行成员 |
| **无 emoji** | 图标只用几何字符、制表符与色块，不会在 iOS 终端上渲染成彩色 emoji |
| **自定义行编辑** | 自管光标，按显示宽度折行，长中文输入与流式输出同屏也不串行 |

## 前置条件

**先跑服务端，再选一端接入。** 没有 `dsh web`，cli 连不上、网页也打不开。

- Node.js **18+**
- 一个正在运行的 `dsh web` 服务（默认 `127.0.0.1:3081`）
- 该服务的数据目录里有 `.launch-token`（cli 端认证用）
- iOS 上跑 web 端还需要装 `web/` 适配层（见「web 端」一节）

> agent 循环、工具、插件、会话存储都在服务端；web 端与 cli 端都只是它的前端。

## 安装

**在 `newteam` 环境里用 git 拉下来就能跑。** 完整步骤见 [`INSTALL.txt`](INSTALL.txt)。

**顺序固定：先 web 端（起服务、开放端口），再 cli 端。** 一次 clone 两端都在仓库里。

```bash
cd <你的 newteam 目录>
git clone https://github.com/axisovo/dsh-ios-roothide.git
cd dsh-ios-roothide

# ① web 端：装 iOS 适配层（带「⟳ 重启」按钮）
./web/install-web.sh <dsh-web-frontend/dist 路径>
curl -X POST http://127.0.0.1:3081/dsh-purge/restart -d '{"reason":"install"}'   # 或点页面上的按钮

# ② 确认端口通了
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/

# ③ cli 端
npm install --omit=dev
DSH_HOME=~/.dsh DSH_PORT=3081 node bin/ds.mjs
```

或者一条命令两端一起装（内部顺序同样是 web → 校验端口 → cli）：

```bash
./install.sh                 # 自动找前端目录；加 --no-restart 不动正在跑的服务
```

不装依赖也能跑，只是需要系统里能找到 `ws`：

```bash
node bin/ds.mjs
```

## 配置

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 数据目录，需含 `.launch-token` |
| `DSH_PORT` | `3081` | dsh web 端口 |
| `DSH_WS_MODULE` | — | `ws` 模块路径（见下方 iOS 说明） |
| `DSH_WHALE_ASSET` | — | 可选：启动横幅的鲸鱼素材 `frames.json` |

```bash
export DSH_HOME=~/.dsh
export DSH_PORT=3081
ds
```

## 用法

```bash
ds              # 交互界面
ds --help
ds --version
```

界面里输入 `/` 弹出命令菜单（Tab 补全、↑↓ 选择、前缀过滤）：

| 命令 | 作用 |
|---|---|
| `/help` | 命令列表 |
| `/model [名字]` | 查看 / 切换模型 |
| `/think [级别]` | 思考深度：off \| low \| medium \| high |
| `/team [on\|off]` | 团队智能体协作模式 |
| `/usage` | token 用量（当前会话 + 全部） |
| `/plugins` | 已加载的插件 / bundle |
| `/tasks` | 定时任务 |
| `/skills` | 可用 skills |
| `/resume` | 从历史会话继续 |
| `/rename [标题]` `/fork` `/new` `/session` | 会话管理 |
| `/stop` | 中断当前回合 |
| `/clear` `/exit` | 清屏 / 退出 |

### 按键

| 键 | 行为 |
|---|---|
| `Enter` | 空闲：发送；忙碌：**排队**，当前回合结束后自动发 |
| `Alt+Enter` | **插入**：立刻塞进正在跑的回合 |
| `Esc` | 中断当前回合 |
| `Ctrl+C` | 有输入清行；无输入中断 / 退出 |
| `↑` `↓` | 历史输入 |
| `Ctrl+A/E/U/K/W`、`Home/End`、`Backspace/Delete` | 行编辑 |

### 拖拽文件

把文件拖进终端，路径会归一化后落进输入框：

- 去 `file://` 前缀、`decodeURIComponent`、剥引号、还原 `\ ` 转义空格、展开 `~`
- 提交时若识别到路径，会先打印 `⇥ 附件 N：文件名` 供确认

## 越狱插件形式（.deb）

除了源码部署，两端也可以**打成一个 RootHide rootless 插件包**，用 Sileo / Filza / `dpkg -i` 装上就用：

```bash
./packaging/build-deb.sh --tier=slim   # 约 5 MB：只用设备已有的 dsh
./packaging/build-deb.sh --tier=cli    # 约 41 MB：自带裁剪过的运行时，终端可用
./packaging/build-deb.sh --tier=full   # cli + web 适配层（含一键重启）
dpkg -i dist/dsh-ios-roothide_<ver>_iphoneos-arm64.deb
```

| 档位 | deb | 安装后 | 说明 |
|---|---|---|---|
| `slim` | ≈ 5 MB | ≈ 6 MB | 依赖设备已有的 dsh 安装 |
| `cli` | **≈ 41 MB** | ≈ 642 MB | 自带 node + 裁剪运行时；实测启动 **49 s**（全量 88 s） |
| `full` | ≈ 43 MB | ≈ 668 MB | 再加 web 适配层与一键重启 |

裁剪掉的东西：`libreoffice-kit-wasm`（146 MB，WASM 在 jitless 下根本不能跑）、
`documentpreview` / `experimental-*`（共 97 MB）、`*.map` / `*.d.ts` / `*.md` / `tests` / `docs`。

移动端形态（PWA / WebClip / 原生壳 App 等七种方案的对比与推荐）见
[docs/MOBILE-OPTIONS.md](docs/MOBILE-OPTIONS.md)。

装完你会得到：

| 路径 | 作用 |
|---|---|
| `/var/jb/usr/bin/ds` | cli 端启动器（`ds`，需在 newteam 中唤起） |
| `/var/jb/usr/bin/dsh-ui` | 用浏览器打开本地界面（`uiopen http://127.0.0.1:3081/`） |
| `/var/jb/Library/LaunchDaemons/com.axisovo.dsh-web.plist` | 开机自启的 web 服务（`RunAtLoad` + 退出非 0 时重启） |
| `/var/jb/usr/libexec/dsh-ios-roothide/web.sh` | 守护进程入口：解析 node、注入 iOS shim、起 `dsh web` |
| `/var/jb/etc/dsh-ios-roothide.conf` | 配置：`DSH_ROOT` / `DSH_HOME` / `DSH_PORT` / `DSH_NODE` |
| `/var/jb/usr/share/dsh-ios-roothide/` | cli 源码 + web 适配层 + 文档 |

### 为什么不做成 tweak

本项目**不 hook 任何进程**：web 端是本地页面，cli 端是独立进程，两者都靠 daemon 提供服务。
所以做成"守护进程 + 命令行"的包最稳：

- 不需要 `MobileSubstrate` / `ElleKit` 注入，RootHide 的隐藏机制与它无关
- 不会因为某次 App 更新导致 hook 位置漂移
- 卸载干净：`dpkg -r com.axisovo.dsh-ios-roothide` 即可，`prerm` 会先停掉守护进程

前提：设备上**已经有一份 dsh 安装**（提供 `node` 与 `dsh web`）。装完改 `/var/jb/etc/dsh-ios-roothide.conf`
里的 `DSH_ROOT` 指向它；改完重启守护进程：

```bash
launchctl unload /var/jb/Library/LaunchDaemons/com.axisovo.dsh-web.plist
launchctl load -w /var/jb/Library/LaunchDaemons/com.axisovo.dsh-web.plist
```

日志：`/var/mobile/dsh/dsh-ios/logs/dsh-web.log`

## web 端（iOS Safari 适配 + 一键重启）

上游的 web 界面是给桌面现代浏览器构建的，iOS 16 的 Safari 跑起来会白屏或输入框错位。
本仓库的 `web/` 就是补齐这一层的适配包：

| 文件 | 作用 |
|---|---|
| `web/shim/iterator-polyfill.js` | 补 `Iterator` 相关 API（iOS 16 缺） |
| `web/shim/es-late-polyfill.js` | 补后期 ES 特性，避免首屏直接抛错 |
| `web/shim/keyboard-inset.js` + `.css` | **软键盘弹出时不遮输入框**（用 `visualViewport` 算 inset） |
| `web/shim/composer-focus-ios.js` | iOS 输入法焦点漂移、光标跳位修复 |
| `web/shim/settings-mobile.css` | 移动端设置页布局 |
| `web/assets/index-safari16-v2.js` | 面向 Safari 16 降级构建的入口 bundle（约 1.1 MB） |
| `web/assets/vendor-safari16.js` | 同上，依赖 bundle（约 730 KB） |
| `web/index.html` | 适配后的入口：按顺序注入上述脚本，指向 safari16 构建 |
| **`web/restart-button.js`** | **侧边栏一键重启**（本仓库新增，见下） |

### 安装

```bash
# 指向你机器上的 web 前端目录
./web/install-web.sh ~/.dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist

# 或
DSH_DIST=/path/to/dist ./web/install-web.sh
```

脚本会先把要被覆盖的文件备份成 `*.bak-web`，再落地适配层。装完重启 `dsh web`，
在 Safari 里强刷一次即可。

### 一键重启

`web/restart-button.js` 会在页面左下角挂一个胶囊按钮（避开 iPhone 的 home indicator）：

```
⟳ 重启
```

点击后：

1. `POST /dsh-purge/restart` 让服务端重启（依赖 `dsh-purge` 插件）
2. 轮询首页直到服务重新可用
3. 自动刷新页面，状态依次显示 `重启中` → `已重启`

端点不存在时按钮显示 `未装 purge` 并提示改用 `tools/restart-dsh.mjs`，不会卡住页面。

## 项目结构

```
INSTALL.txt        部署说明（newteam 里 git 拉取 + web 适配层安装）
bin/ds.mjs         入口（--help / --version）
web/               web 端 iOS 适配层与一键重启（见上一节）
src/dsh-live.mjs   主程序：会话、事件渲染、命令、输入区装配
src/dsh-remote.mjs 协议层：认证、unary RPC、WebSocket 多路复用流
src/dsh-input.mjs  行编辑器：自管光标、按显示宽度折行、粘贴处理
src/dsh-anim.mjs   活动行动画（呼吸竖条 + 扫光文字）
src/dsh-diff.mjs   行级 diff 模型（LCS 对齐、行号、上下文裁剪）
src/dsh-whale.mjs  启动横幅的像素画渲染（面积平均采样 → 半块字符）
docs/PROTOCOL.md   协议细节与踩坑记录
```

## 开发

```bash
npm run check     # 语法检查
```

没有测试框架，验证方式是**真机回放**：用 pty 跑起来、喂指令、抓全部输出字节，再用一个最小 ANSI 终端模拟器还原屏幕来核对排版。复现方法见 `docs/PROTOCOL.md` 末尾。

## iOS / 无 JIT 环境

越狱的 iOS 上 Node 常跑在 jitless 模式：

1. 用纯 JS 的 `ws`（npm 默认实现本身就是纯 JS，一般无需额外处理）
2. 若环境提供了自带副本，用 `DSH_WS_MODULE` 指过去
3. 服务端与客户端同机时注意 `/var/mobile` 与 AppGroup 的路径命名空间差异——CLI 侧用 `DSH_HOME` 明确指定，不要去猜

## 协议

见 [docs/PROTOCOL.md](docs/PROTOCOL.md)：认证、两种 RPC 形态、`session/follow` 帧结构，以及**为什么不能用全局 `$events` 订阅**（会收到别的会话的正文）。

## 测试环境

开发与验证都跑在这台机器上：

| 项 | 值 |
|---|---|
| 设备 | iPhone SE 2（`iPhone12,8` / `D79AP`），A13，6 核，3 GB RAM |
| 系统 | iOS 16.3（Darwin 22.3.0，xnu-8792.82.2），arm64e |
| 越狱 | RootHide（rootless，`/var/jb`），ElleKit |
| 运行时 | Node **v24.21.0**（`--jitless`） |
| 服务端 | dsh **0.2.2-rc.5**，`127.0.0.1:3081` |
| 验证方式 | `pty.fork()` 起伪终端 → 喂指令 → 抓全部输出字节 → 最小 ANSI 模拟器回放核对 |

> 在这套环境里 Node 没有 JIT，`ws` 走纯 JS 路径；路径还有 AppGroup 与 `/var/mobile` 两个命名空间的差异，所以 CLI 侧一律用 `DSH_HOME` 显式指定。

## 运行环境

- **服务端**：本机运行 `dsh web`（`@deepseek-ai/dsh`），监听 3081
- **客户端**：Node ≥ 18；macOS / Linux / WSL 均可，越狱 iOS 也能直接跑（`--jitless`）
- **终端**：256 色；宽度 ≥ 60 列体验最佳，< 44 列不画启动横幅的鲸鱼

## 上传到 GitHub

不依赖 `git` 或 `curl`，直接走 GitHub API（Git Data API：blob → tree → commit → ref）：

```bash
export GITHUB_TOKEN=ghp_xxx        # 需要 repo 权限

node scripts/upload.mjs            # 仓库名 = 目录名，public
node scripts/upload.mjs my-repo    # 自定义名字
node scripts/upload.mjs my-repo private
node scripts/upload.mjs --dry-run  # 只列文件，不发请求
```

等价入口：`./scripts/upload.sh <name> <visibility>`。

令牌只从环境变量读，不写进任何文件，也不会出现在 remote 里。

## 鸣谢

本项目站在这些工作的肩膀上：

- **[DeepSeek Harness](https://github.com/deepseek-ai)**（`@deepseek-ai/dsh`）—— 服务端、agent 循环、会话与工具协议的全部来源；
  没有它的 `session/follow`、`assistant-stream` 与 durable event 模型，这个客户端无从谈起
- **[ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)** —— 启动横幅的鲸鱼像素素材（`@deepseek-harness-tui/dsh-tui`）与终端观感的早期参考
- **[Claude Code](https://github.com/anthropics/claude-code)**（Anthropic）—— 终端排版与流式呈现的对标对象：
  `● Tool(args)` / `└ result` 的卡片式工具行、状态行的收敛方式、边跑边排队的输入模型
- **[Codex CLI](https://github.com/openai/codex)**（OpenAI）—— 思考行"不独占提示行、结束后收敛"的表现思路
- **[ws](https://github.com/websockets/ws)** —— WebSocket 实现（纯 JS，无 JIT 环境可用）
- **[Node.js](https://github.com/nodejs/node)** —— 运行时

## License

MIT
