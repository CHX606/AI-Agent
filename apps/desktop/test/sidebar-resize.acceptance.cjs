const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const assert = require("node:assert/strict");
const directory = process.argv[2];
app.setPath("userData", join(directory, "profile"));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error("侧栏调宽验收超时"); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  const js = source => window.webContents.executeJavaScript(source, true);
  const frame = () => js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const width = () => js("document.querySelector('.sidebar-left').getBoundingClientRect().width");
  const drag = async distance => {
    const point = await js("(()=>{const b=document.querySelector('#sidebar-resize').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:100}})()");
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    await frame();
    window.webContents.sendInputEvent({ type: "mouseMove", x: point.x + distance, y: point.y });
    await frame();
    return { x: point.x + distance, y: point.y };
  };
  const release = async point => {
    window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    await frame();
    assert.equal(await js("document.body.dataset.sidebarResizing ?? ''"), "",
      JSON.stringify(await js("({w:innerWidth,p:window.resizePointer,c:document.querySelector('#sidebar-resize').hasPointerCapture(window.resizePointer),bounds:document.querySelector('#sidebar-resize').getBoundingClientRect().toJSON(),sidebar:document.querySelector('.sidebar-left').getBoundingClientRect().width})")));
  };
  const safeLayout = async () => {
    const bounds = await js("(()=>{const s=document.querySelector('.shell');const m=document.querySelector('.main-center').getBoundingClientRect();return {width:innerWidth,main:m.width,overflow:s.scrollWidth>s.clientWidth}})()");
    assert.ok(bounds.main >= 480, JSON.stringify(bounds));
    assert.equal(bounds.overflow, false, JSON.stringify(bounds));
  };
  await window.loadFile(join(directory, "index.html"));
  assert.equal(await width(), 260);
  await release(await drag(80));
  assert.equal(await width(), 340);
  assert.equal(await js("localStorage.getItem('bit-agent.sidebar-width.v1')"), "340");
  await js("document.querySelector('.shell').dataset.view='repository'");
  await frame();
  assert.equal(await width(), 340);
  await window.webContents.reload();
  await new Promise(resolve => window.webContents.once("did-finish-load", resolve));
  assert.equal(await width(), 340);
  window.setContentSize(920, 900);
  await frame();
  await release(await drag(500));
  assert.equal(await width(), 440);
  await js("document.querySelector('#sidebar-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  assert.equal(await width(), 180);
  await js("document.querySelector('#sidebar-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  assert.equal(await width(), 190);
  const cancelled = await drag(30);
  await js("document.querySelector('#sidebar-resize').dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.resizePointer}))");
  await release(cancelled);
  const lost = await drag(10);
  await js("document.querySelector('#sidebar-resize').releasePointerCapture(window.resizePointer)");
  await release(lost);
  await drag(30);
  window.setContentSize(680, 900);
  await frame();
  assert.equal(await width(), 48);
  assert.equal(await js("getComputedStyle(document.querySelector('#sidebar-resize')).display"), "none");
  assert.equal(await js("document.body.dataset.sidebarResizing ?? ''"), "");
  window.setContentSize(1280, 900);
  await frame();
  await js("const s=document.querySelector('.shell');s.dataset.inspectorCollapsed='false';s.dataset.view='tasks';document.querySelector('#sidebar-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
  await frame();
  assert.equal(await width(), 520);
  await js("document.documentElement.style.setProperty('--inspector-width','520px')");
  await frame();
  assert.equal(await width(), 520);
  await safeLayout();
  const requestedRight = await js("document.documentElement.style.getPropertyValue('--inspector-width')");
  assert.equal(requestedRight, "520px");
  for (const viewport of [1051, 1100, 1280]) {
    window.setContentSize(viewport, 900);
    await frame();
    await safeLayout();
    await release(await drag(-60));
    await safeLayout();
    await release(await drag(500));
    assert.equal(await width(), Math.min(520, await js("innerWidth") - 760));
    await safeLayout();
    await js("document.documentElement.style.setProperty('--inspector-width','320px')");
    await frame();
    await safeLayout();
    await js("document.documentElement.style.setProperty('--inspector-width','520px')");
    await frame();
    await safeLayout();
  }
  window.setContentSize(1520, 900);
  await frame();
  assert.equal(await js("document.querySelector('.sidebar-right').getBoundingClientRect().width"), 520);
  await safeLayout();
  window.setContentSize(920, 900);
  await frame();
  assert.equal(await js("getComputedStyle(document.querySelector('.sidebar-right')).position"), "absolute");
  assert.equal(await width(), 440);
  const result = { nativePointerDrag: true, persistentWidth: true, sharedViews: true, narrowScreen: true,
    keyboard: true, pointerCancel: true, lostCapture: true, inspectorConstraint: true,
    desktopWidths: [1051, 1100, 1280], restoredInspectorPreference: true, floatingInspector: true };
  writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log("SIDEBAR_RESIZE_ACCEPTANCE_PASSED", JSON.stringify(result));
  clearTimeout(watchdog);
  app.exit(0);
}).catch(error => { console.error(error.stack ?? error); clearTimeout(watchdog); app.exit(1); });
