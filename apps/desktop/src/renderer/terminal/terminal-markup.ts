const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
export { icon as terminalIcon };

export const terminalMarkup = `
    <div class="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="调整终端高度" tabindex="0"></div>
    <header class="terminal-header">
      <div class="terminal-tabs" role="tablist" aria-label="终端"></div>
      <button type="button" class="icon-button" data-action="new" title="新建终端（Ctrl+Shift+T）" aria-label="新建终端">${icon("M12 5v14M5 12h14")}</button>
      <span class="terminal-cwd"></span>
      <div class="terminal-actions">
        <button type="button" class="icon-button" data-action="quote" title="引用到对话：选中的文字，没选中时为最后 60 行" aria-label="引用到对话">${icon("M8 9h8M8 13h5M5 5h14v11H9l-4 3z")}</button>
        <button type="button" class="icon-button" data-action="find" title="查找（Ctrl+Shift+F）" aria-label="查找">${icon("m20 20-4.2-4.2M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z")}</button>
        <button type="button" class="icon-button" data-action="restart" title="重新启动终端" aria-label="重新启动终端">${icon("M19 7v5h-5M18 11a6.5 6.5 0 1 0-1.6 5.2")}</button>
        <button type="button" class="icon-button" data-action="hide" title="隐藏终端（Ctrl+\`）" aria-label="隐藏终端">${icon("m6 9 6 6 6-6")}</button>
      </div>
    </header>
    <div class="terminal-find" role="search" hidden>
      <input type="text" spellcheck="false" placeholder="在终端中查找" aria-label="在终端中查找">
      <span class="terminal-find-count" aria-live="polite"></span>
      <button type="button" class="icon-button" data-find="previous" title="上一个（Shift+Enter）" aria-label="上一个">${icon("m6 15 6-6 6 6")}</button>
      <button type="button" class="icon-button" data-find="next" title="下一个（Enter）" aria-label="下一个">${icon("m6 9 6 6 6-6")}</button>
      <button type="button" class="icon-button" data-find="close" title="关闭（Esc）" aria-label="关闭查找">${icon("m6 6 12 12M18 6 6 18")}</button>
    </div>
    <div class="terminal-host"></div>`;
