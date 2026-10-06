const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
export const globeIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.5 5.2 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.2-3.5-8.5s1.1-6.2 3.5-8.5z"/></svg>`;
export const closeIcon = icon("m7 7 10 10M17 7 7 17");

export const browserMarkup = `
  <div class="browser-resize" role="separator" aria-orientation="vertical" aria-label="调整浏览器宽度" tabindex="0"></div>
  <div class="browser-tabbar">
    <div class="browser-tabs" role="tablist" aria-label="标签页"></div>
    <button type="button" class="icon-button browser-new-tab" data-action="new-tab" title="新建标签页（Ctrl+T）" aria-label="新建标签页">${icon("M12 5v14M5 12h14")}</button>
  </div>
  <header class="browser-toolbar">
    <button type="button" class="icon-button" data-action="back" title="后退（Alt+←）" aria-label="后退">${icon("M15 6l-6 6 6 6")}</button>
    <button type="button" class="icon-button" data-action="forward" title="前进（Alt+→）" aria-label="前进">${icon("M9 6l6 6-6 6")}</button>
    <button type="button" class="icon-button browser-reload" data-action="reload" title="重新加载（F5）" aria-label="重新加载">
      <svg class="browser-icon-reload" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 7v5h-5M18 11a6.5 6.5 0 1 0-1.6 5.2"/></svg>
      <svg class="browser-icon-stop" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
    </button>
    <form class="browser-address" autocomplete="off">
      <span class="browser-address-icon">${globeIcon}</span>
      <input type="text" spellcheck="false" placeholder="输入网址或搜索（Ctrl+L）" aria-label="地址">
      <button type="button" class="browser-zoom" data-action="zoom-reset" title="恢复到 100%（Ctrl+0）" hidden></button>
    </form>
    <button type="button" class="icon-button" data-action="external" title="在系统浏览器中打开" aria-label="在系统浏览器中打开">${icon("M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4")}</button>
    <button type="button" class="icon-button" data-action="devtools" title="开发者工具（F12）" aria-label="开发者工具">${icon("m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12")}</button>
    <button type="button" class="icon-button" data-action="close" title="关闭浏览器" aria-label="关闭浏览器">${icon("m6 6 12 12M18 6 6 18")}</button>
  </header>
  <div class="browser-progress" aria-hidden="true"></div>
  <div class="browser-find" role="search" hidden>
    <input type="text" spellcheck="false" placeholder="在页面中查找" aria-label="在页面中查找">
    <span class="browser-find-count" aria-live="polite"></span>
    <button type="button" class="icon-button" data-find="previous" title="上一个（Shift+Enter）" aria-label="上一个">${icon("m6 15 6-6 6 6")}</button>
    <button type="button" class="icon-button" data-find="next" title="下一个（Enter）" aria-label="下一个">${icon("m6 9 6 6 6-6")}</button>
    <button type="button" class="icon-button" data-find="close" title="关闭（Esc）" aria-label="关闭查找">${icon("m6 6 12 12M18 6 6 18")}</button>
  </div>
  <div class="browser-stage">
    <img class="browser-snapshot" alt="" hidden>
    <section class="browser-start" aria-label="起始页">
      <h3>打开网页</h3>
      <p>在上方输入网址，或输入 <code>localhost:5173</code> 这样的本机地址预览开发中的页面。</p>
      <div class="browser-servers" data-state="loading">
        <header><span>本机开发服务器</span><button type="button" class="browser-link" data-refresh>重新检测</button></header>
        <div class="browser-servers-list"></div>
        <p class="browser-servers-empty">常用端口上没有发现正在运行的服务。</p>
        <p class="browser-servers-loading">正在检测…</p>
      </div>
      <div class="browser-recent-section" hidden>
        <header><span>最近访问</span></header>
        <div class="browser-recent"></div>
      </div>
    </section>
    <section class="browser-error" role="alert" hidden>
      <h3 class="browser-error-title">无法打开这个网页</h3>
      <p class="browser-error-detail"></p>
      <code class="browser-error-url"></code>
      <small class="browser-error-code"></small>
      <div class="browser-error-actions">
        <button type="button" class="button-primary" data-retry>重试</button>
        <button type="button" class="button-secondary" data-external>在系统浏览器中打开</button>
      </div>
    </section>
  </div>
  <div class="browser-downloads" aria-label="下载" aria-live="polite" hidden></div>`;
