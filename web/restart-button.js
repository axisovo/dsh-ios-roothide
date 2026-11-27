// restart-button.js — web 端侧边栏一键重启
//
// 侧边栏是 React 渲染的，没有稳定插槽，所以这里用"固定胶囊按钮 + 安全区偏移"：
// 桌面端贴在左下角，iPhone 上避开 home indicator。点击后调用 purge 插件的重启端点，
// 然后轮询首页直到服务回来，再自动刷新。
//
// 端点：POST /dsh-purge/restart  {reason}
// 依赖：dsh-purge（本机已装）；没有该插件时按钮会提示改用 tools/restart-dsh.mjs。
(function () {
  if (window.__dshRestartButton) return;
  window.__dshRestartButton = true;

  const ID = "dsh-restart-pill";
  const style = document.createElement("style");
  style.textContent = `
    #${ID} {
      position: fixed;
      left: max(12px, env(safe-area-inset-left));
      bottom: max(12px, env(safe-area-inset-bottom));
      z-index: 2147483000;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 999px;
      border: 1px solid rgba(128, 138, 158, 0.35);
      background: rgba(24, 28, 38, 0.82);
      color: #cbd3e6;
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 120ms ease;
    }
    #${ID}:active { transform: scale(0.96); }
    #${ID}[data-state="running"] { color: #9ad7ff; border-color: rgba(93, 176, 255, 0.55); }
    #${ID}[data-state="ok"]      { color: #8ce99a; border-color: rgba(99, 214, 122, 0.55); }
    #${ID}[data-state="error"]   { color: #ff9b9b; border-color: rgba(255, 120, 120, 0.55); }
    #${ID} .dsh-restart-glyph {
      display: inline-block;
      font-size: 13px;
      line-height: 1;
    }
    #${ID}[data-state="running"] .dsh-restart-glyph { animation: dsh-restart-spin 900ms linear infinite; }
    @keyframes dsh-restart-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: light) {
      #${ID} { background: rgba(255, 255, 255, 0.88); color: #3b4256; border-color: rgba(60, 70, 90, 0.22); }
    }
  `;
  document.head.appendChild(style);

  const button = document.createElement("button");
  button.id = ID;
  button.type = "button";
  button.dataset.state = "idle";
  button.title = "重启 dsh web（POST /dsh-purge/restart）";
  button.innerHTML = '<span class="dsh-restart-glyph">⟳</span><span class="dsh-restart-label">重启</span>';

  const label = () => button.querySelector(".dsh-restart-label");
  const setState = (state, text) => {
    button.dataset.state = state;
    label().textContent = text;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitForServer(maxMs = 45000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`./?t=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
        if (res.ok) return true;
      } catch { /* 还没起来 */ }
      await sleep(800);
    }
    return false;
  }

  let busy = false;
  async function restart() {
    if (busy) return;
    busy = true;
    setState("running", "重启中");
    try {
      const res = await fetch("/dsh-purge/restart", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "web ui: 一键重启" }),
      });
      if (res.status === 404) {
        setState("error", "未装 purge");
        console.warn("[dsh] /dsh-purge/restart 不存在，用 tools/restart-dsh.mjs 或手动重启");
        await sleep(2600);
        setState("idle", "重启");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 端点已受理，等端口重新可用后刷新页面
      const up = await waitForServer();
      if (up) {
        setState("ok", "已重启");
        await sleep(400);
        location.reload();
        return;
      }
      setState("error", "未回来");
      await sleep(2600);
      setState("idle", "重启");
    } catch (error) {
      console.warn("[dsh] 重启失败：", error);
      setState("error", "失败");
      await sleep(2600);
      setState("idle", "重启");
    } finally {
      busy = false;
    }
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    restart();
  });

  const mount = () => document.body.appendChild(button);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
