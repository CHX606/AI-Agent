const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const directory = process.argv[2];
app.setPath("userData", join(directory, "profile"));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error("Markdown 界面验收超时"); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1100, height: 900, show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadFile(join(directory, "index.html"));
  const result = await window.webContents.executeJavaScript("window.markdownAcceptance()", true);
  const layouts = [];
  for (const width of [1100, 640]) {
    window.setSize(width, 900);
    for (const theme of ["light", "dark"]) {
      await window.webContents.executeJavaScript(`window.markdownLayout(${JSON.stringify(theme)})`);
      await window.webContents.executeJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      layouts.push(await window.webContents.executeJavaScript(`window.markdownLayout(${JSON.stringify(theme)})`));
      const shot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      writeFileSync(join(directory, `markdown-${theme}-${width}.png`), shot.toPNG());
    }
  }
  writeFileSync(join(directory, "result.json"), JSON.stringify({ ...result, layouts }, null, 2));
  console.log("MARKDOWN_RENDERER_ACCEPTANCE_PASSED", JSON.stringify({ ...result, layouts }));
  clearTimeout(watchdog);
  app.exit(0);
}).catch(error => { console.error(error.stack ?? error); clearTimeout(watchdog); app.exit(1); });
