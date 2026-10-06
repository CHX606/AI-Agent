/**
 * 界面错位/重叠检查：在终端、浏览器、代码仓库页、收起侧栏等组合下，
 * 找出互相重叠的控件、超出窗口的控件、被父容器截掉的控件，并截图留档。
 */

// 在页面里运行：返回问题列表。弹窗、下拉菜单本来就盖在别的内容上，不算。
export const AUDIT = String.raw`(() => {
  const selector = 'button, input:not([type=hidden]), select, textarea, [role=tab], .status-badge, .task-title, .terminal-cwd,'
    + ' .browser-tab-title, .terminal-tab > span, .section-label, .history-item, .workspace-group-header, .editor-tab, .mcp-type';
  // 弹窗、菜单本来就盖在别的内容上，不检查。
  const overlay = 'dialog, .choice-popover, #profile-menu, .browser-suggestions, .xterm, .browser-snapshot';
  const visible = (element) => {
    if (element.closest(overlay) || element.closest('[hidden]')) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
    }
    return true;
  };
  const name = (element) => {
    const label = (element.getAttribute('aria-label') || element.title || element.textContent || element.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (element.classList.length ? '.' + [...element.classList].slice(0, 2).join('.') : '') + (label ? ' "' + label + '"' : '');
  };
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const area = (rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
  // 可见部分：依次裁到每个溢出不可见的祖先。可滚动容器里滚出去的部分本来就看不见，不算问题；
  // 被不能滚动的容器截掉才算“被截断”。
  const measure = (element) => {
    const box = element.getBoundingClientRect();
    let rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    let clippedBy = null;
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      const flow = style.overflowX + ' ' + style.overflowY;
      if (!/(hidden|clip|auto|scroll)/.test(flow)) continue;
      const before = area(rect);
      rect = intersect(rect, node.getBoundingClientRect());
      if (!clippedBy && !/(auto|scroll)/.test(flow) && before - area(rect) > 4) clippedBy = node;
    }
    return { rect, clippedBy, full: box };
  };
  const titlebar = document.querySelector('.window-titlebar')?.getBoundingClientRect().bottom ?? 0;
  // 浮动面板（窄窗口时的浏览器、任务详情）有意盖住下面的内容：被盖住的部分看不见，从可见区域里扣掉。
  // 面板都贴着右边，所以只需要把被盖住的控件右边界收到面板左边。
  const panels = [...document.querySelectorAll('.browser-pane, .sidebar-right')]
    .filter((panel) => getComputedStyle(panel).position === 'absolute' && visible(panel))
    .map((panel) => ({ panel, box: panel.getBoundingClientRect() }));
  const uncover = (item) => {
    for (const { panel, box } of panels) {
      if (panel.contains(item.element) || area(intersect(item.rect, box)) === 0) continue;
      item.rect = { ...item.rect, right: Math.min(item.rect.right, box.left) };
    }
    return item;
  };
  const controls = [...document.querySelectorAll(selector)].filter(visible)
    .map((element) => uncover({ element, ...measure(element) })).filter((item) => area(item.rect) > 4);
  const issues = [];
  for (let i = 0; i < controls.length; i += 1) {
    const a = controls[i];
    if (a.rect.right > innerWidth + 1 || a.rect.left < -1 || a.rect.bottom > innerHeight + 1) issues.push({ kind: 'offscreen', a: name(a.element) });
    if (a.rect.top < titlebar - 1) issues.push({ kind: 'under-titlebar', a: name(a.element), top: Math.round(a.rect.top) });
    // 文字用省略号截断是有意的（截的是元素自己），这里只看被祖先容器截掉的。
    if (a.clippedBy) issues.push({ kind: 'clipped', a: name(a.element), by: name(a.clippedBy), cut: Math.round(area(a.full) - area(a.rect)) });
    for (let j = i + 1; j < controls.length; j += 1) {
      const b = controls[j];
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      const shared = area(intersect(a.rect, b.rect));
      if (shared > 6) issues.push({ kind: 'overlap', a: name(a.element), b: name(b.element), area: Math.round(shared) });
    }
  }
  return issues;
})()`;

const click = (selector) => `document.querySelector(${JSON.stringify(selector)})?.click()`;

/** 组合各种状态，返回每种状态下的问题；截图写进 shots。 */
export async function auditLayouts({ command, evaluate, check, main }) {
  const results = [];
  const shots = [];
  // 只为留档：直接截窗口画面，不做主题取色校验（窄窗口时浏览器面板会盖住校验取色的位置）。
  const shoot = async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const data = await main(`(async () => {
      const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app/package.json')('electron');
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('index.html'));
      window.webContents.setBackgroundThrottling(false);
      await window.webContents.capturePage(undefined, { stayHidden:true, stayAwake:true });
      await new Promise(resolve => setTimeout(resolve, 200));
      return (await window.webContents.capturePage(undefined, { stayHidden:true, stayAwake:true })).toPNG().toString('base64');
    })()`);
    shots.push({ name, data });
  };
  const state = (expression) => evaluate(`(() => { const shell=document.querySelector('.shell'); ${expression} })()`);
  const ensure = async ({ view = "tasks", terminal = false, browser = false, sidebarCollapsed = false, inspector = false }) => {
    await evaluate(click(view === "tasks" ? "#nav-tasks" : "#nav-repository"));
    if ((await state("return shell.dataset.inspectorCollapsed==='false'")) !== inspector) {
      await evaluate(inspector ? "document.querySelector('.shell').dataset.view==='tasks' && document.querySelector('.shell').dataset.browserOpen!=='true' ? document.querySelector('#inspector-toggle').click() : null"
        : click("#inspector-close"));
    }
    if ((await state("return shell.dataset.sidebarCollapsed")) !== String(sidebarCollapsed)) await evaluate(click("#sidebar-toggle"));
    if ((await state("return document.querySelector('#terminal-panel').hidden===false")) !== terminal) {
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'`',ctrlKey:true,bubbles:true}))");
    }
    if ((await state("return shell.dataset.browserOpen==='true'")) !== browser) {
      await evaluate(browser ? "document.querySelector('.shell').dataset.view==='tasks' ? document.querySelector('#browser-toggle').click() : null"
        : click("#browser-pane [data-action=close]"));
    }
  };

  // 准备：浏览器开 3 个只显示起始页的标签（不加载网页，截图能看到面板），标题很长的情况用终端多标签覆盖。
  await evaluate(click("#nav-tasks"));
  await ensure({ browser: true, terminal: true });
  for (let index = 0; index < 2; index += 1) await evaluate(click("#browser-pane .browser-new-tab"));
  await evaluate(click("#terminal-panel [data-action=new]"));
  await evaluate(click("#terminal-panel [data-action=new]"));
  await check(() => evaluate("document.querySelectorAll('#terminal-panel .terminal-tab').length===3"), "布局检查：终端标签没有建好");

  const combos = [
    { name: "tasks-terminal-browser", view: "tasks", terminal: true, browser: true },
    { name: "tasks-terminal-browser-find", view: "tasks", terminal: true, browser: true, find: true },
    { name: "tasks-collapsed-terminal-browser", view: "tasks", terminal: true, browser: true, sidebarCollapsed: true },
    { name: "repository-terminal-browser", view: "repository", terminal: true, browser: true },
    { name: "repository-terminal", view: "repository", terminal: true, browser: false },
    { name: "tasks-terminal", view: "tasks", terminal: true, browser: false },
    { name: "tasks-inspector-terminal", view: "tasks", terminal: true, browser: false, inspector: true },
  ];
  for (const width of [1280, 920]) {
    const height = width === 920 ? 680 : 820;
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await evaluate(`if(document.documentElement.dataset.theme!==${JSON.stringify(theme)})document.querySelector('#theme-toggle').click()`);
      for (const combo of combos) {
        await ensure(combo);
        if (combo.find) await evaluate("document.querySelector('#terminal-panel [data-action=find]').click()");
        await new Promise((resolve) => setTimeout(resolve, 200));
        const issues = await evaluate(AUDIT);
        results.push({ combo: combo.name, width, theme, issues });
        await shoot(`audit-${combo.name}-${theme}-${width}.png`);
        if (combo.find) await evaluate("document.querySelector('#terminal-panel .terminal-find input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      }
    }
  }
  // 应用界面放大到 125%：等于窗口变窄，几种常用组合再检查一遍。
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate("if(document.documentElement.dataset.theme!=='light')document.querySelector('#theme-toggle').click()");
  await evaluate("window.bitAgent.setZoom('in').then(() => window.bitAgent.setZoom('in'))");
  for (const combo of combos.filter((item) => ["tasks-terminal-browser", "repository-terminal-browser", "tasks-inspector-terminal"].includes(item.name))) {
    await ensure(combo);
    await new Promise((resolve) => setTimeout(resolve, 200));
    results.push({ combo: combo.name, width: 1280, theme: "light-zoom-125", issues: await evaluate(AUDIT) });
    await shoot(`audit-${combo.name}-zoom125-1280.png`);
  }
  await evaluate("window.bitAgent.setZoom('reset')");

  // 收拾：关掉多余的终端和浏览器标签，恢复默认状态。
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await ensure({ view: "tasks", terminal: true, browser: true, sidebarCollapsed: false });
  await evaluate(`document.querySelectorAll('#browser-pane .browser-tab .browser-tab-close').forEach(button=>button.click());
    [...document.querySelectorAll('#terminal-panel .terminal-tab-close')].slice(1).forEach(button=>button.click())`);
  await ensure({ view: "tasks", terminal: false, browser: false, sidebarCollapsed: false, inspector: true });
  await evaluate("if(document.documentElement.dataset.theme!=='light')document.querySelector('#theme-toggle').click()");
  return { results, shots };
}
