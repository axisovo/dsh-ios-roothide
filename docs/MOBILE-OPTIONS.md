# web 端「变成移动端」方案对比

> 背景：现在的 web 端是浏览器页面（本地 3081 端口）。目标是让它像 App 一样出现在手机上，
> CLI 端保持不变（仍然是在 newteam 里敲 `ds`）。

## 结论速览

| 方案 | 体验 | 工作量 | 体积 | 越狱依赖 | 推荐 |
|---|---|---|---|---|---|
| 1. PWA（添加到主屏） | ★★★☆ | 1–2 小时 | +0 | 否 | ✅ 必做（作为兜底） |
| 2. WebClip 描述文件 | ★★★ | 半天 | +几十 KB | 否 | 可选 |
| 3. 原生壳 App（WKWebView，进 deb） | ★★★★★ | 1–2 天 | +约 1 MB | 是（越狱分发） | ✅ **主推** |
| 4. Capacitor/Cordova 包装 | ★★★☆ | 2–3 天 | +5–15 MB | 是 | ❌ 过度工程 |
| 5. Tweak 注入 SpringBoard/Safari | ★★★★ | 2–3 天 + 长期维护 | +几百 KB | 是 | ❌ 太脆 |
| 6. 快捷指令（Shortcuts） | ★★☆ | 半小时 | 0 | 否 | ✅ 搭配 3 用 |
| 7. Safari 固定标签 / 书签 | ★☆ | 5 分钟 | 0 | 否 | 只作 fallback |

## 1. PWA（推荐先做，成本最低）

仓库里 `dsh-web-frontend/dist/manifest.webmanifest` 已存在，补三件事即可：

- `display: standalone`、`theme_color`、`background_color`
- 192/512 图标（已有）+ `apple-touch-icon`（已有）
- 启动图（`apple-touch-startup-image`）避免白屏

用户操作：Safari 打开 → 分享 → 「添加到主屏幕」。

**优点**：零维护，随 dsh 升级自动更新，无签名问题。
**缺点**：仍是 WebKit 渲染；iOS 16 上后台会被挂起；重启服务后要手动刷新。

## 2. WebClip（.mobileconfig）

生成一个描述文件，装到设备后主屏出现图标，直接全屏打开 `http://127.0.0.1:3081/?token=…`。

**优点**：比 PWA 更可控（图标、全屏、URL 固定），一条命令生成。
**缺点**：本质还是 WebView；token 会写进配置（本机自用没问题，分发要小心）。

## 3. 原生壳 App（主推）

一个极小的 iOS App（Swift 或 ObjC），内容就是一个 `WKWebView` 指向本地端口：

```
DSH.app/
├── Info.plist            LSRequiresIPhoneOS / UISupportedInterfaceOrientations
├── DSH                 ← 编译产物，ldid -S 签名（越狱分发不需要证书）
└── Resources/
    ├── launch.png
    └── warming.html      ← 服务还没起来时的占位页（配合预热）
```

装到 `/var/jb/Applications/DSH.app`，deb 的 `postinst` 里 `uicache -p` 刷新主屏图标。

**能力增益（相对浏览器）**：

- 独立图标 + 真全屏（无地址栏、无 Safari 上下栏）
- 可注入 `js://` 桥：把 `⟳ 重启` 从网页按钮变成原生按钮
- 可处理键盘弹出 / 安全区 / 横竖屏
- 冷启动时先显示占位页，探测到端口再 `loadRequest`（消除 88 秒白屏）
- 可在进入后台时保活一段时间（`beginBackgroundTask`），减少重连
- 可加「分享到 DSH」「从相册选图给对话」等原生入口

**代价**：需要一个 iOS 编译环境（Xcode，或用 theos + iOS SDK 交叉编译）。越狱分发可 `ldid` 自签，无需开发者账号。
**体积**：增加约 1 MB（二进制 + 图标），相对 642 MB 的运行时可以忽略。

## 4. Capacitor / Cordova

把现有 web 代码包进原生容器。

**不推荐**：为「指向 localhost 的页面」引入一整套桥接层，包体 +5–15 MB、启动更慢，收益不如 3。

## 5. Tweak 注入（SpringBoard / Safari）

用 ElleKit hook SpringBoard 加图标，或往 Safari 注入工具栏。

**不推荐**：系统小版本更新即可能失效；与 RootHide 的隐藏机制相互干扰；调试成本高。
**只有一种情况值得**：想做到「长按图标 → 直接重启服务」这种系统级菜单，可以用一个极小的 SpringBoard 插件补，但应作为方案 3 的补充而非主体。

## 6. 快捷指令（Shortcuts）

两个 Action：`打开 URL` + `发送请求（POST /dsh-purge/restart）`。可加到主屏、可 Siri 唤醒（"嘿 Siri，重启 DSH"）。

**建议**：作为方案 3 的补充，成本半小时。

## 7. Safari 书签 / 固定标签

零成本兜底。用户没有装 App 时仍能用。

---

## 建议的落地顺序

1. **方案 1（PWA）** —— 1 小时，立刻改善所有用户的主屏体验（不依赖越狱）
2. **方案 3（原生壳）** —— 主推，装进同一个 deb；带占位页 + 原生重启按钮
3. **方案 6（快捷指令）** —— 半小时，给「服务挂了要重启」一个系统级入口
4. 方案 2/5/4 不做

## 与 deb 档位的关系

| deb 档位 | 内容 | 移动端形态 |
|---|---|---|
| `slim` | 适配层 + 启动器 | 依赖设备已有 dsh；主屏用 PWA/WebClip |
| `cli` | 自带运行时（裁剪后），终端可用 | 可选装壳 App |
| `full` | `cli` + 原生壳 App + PWA 清单 | **开箱即「移动端」** |

> 移动端壳 App 只随 `full` 档发布，`slim`/`cli` 档保持轻量。
