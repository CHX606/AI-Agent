const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const directory = process.argv[2];
app.setPath("userData", join(directory, "profile"));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error("图片输入界面验收超时"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 900, show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(join(directory, "index.html"));
  const result = await window.webContents.executeJavaScript("window.runImageAcceptance()", true);
  const shot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  writeFileSync(join(directory, "image-messages.png"), shot.toPNG());
  writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log("IMAGE_COMPOSER_ACCEPTANCE_PASSED", JSON.stringify(result));
  clearTimeout(watchdog);
  app.exit(0);
}).catch(error => { console.error(error.stack ?? error); clearTimeout(watchdog); app.exit(1); });
