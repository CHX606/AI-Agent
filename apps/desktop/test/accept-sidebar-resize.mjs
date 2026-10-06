import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const directory = mkdtempSync(join(root, "tmp", "sidebar-resize-"));
const require = createRequire(join(root, "apps", "desktop", "package.json"));
const esbuildDirectory = readdirSync(join(root, "node_modules", ".pnpm")).find(name => /^esbuild@/u.test(name));
if (!esbuildDirectory) throw new Error("缺少项目已有的 esbuild 依赖");
const esbuild = await import(pathToFileURL(join(root, "node_modules", ".pnpm", esbuildDirectory,
  "node_modules", "esbuild", "lib", "main.js")).href);
await esbuild.build({ entryPoints: [join(import.meta.dirname, "sidebar-resize.fixture.ts")], bundle: true,
  outfile: join(directory, "fixture.js"), platform: "browser", format: "iife", target: "chrome140" });
writeFileSync(join(directory, "index.html"), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css"><style>:root{--app-height:100vh}.sidebar-right{background:var(--bg-sidebar)}
.main-center{min-width:0;background:var(--bg-main)}</style></head><body><div class="shell" data-view="tasks" data-inspector-collapsed="true">
<aside class="sidebar-left"><nav class="app-rail"></nav><div class="sidebar-pane" id="task-sidebar-pane">工作区</div>
<div class="sidebar-pane" id="repository-sidebar-pane" hidden>代码树</div></aside><main class="main-center">对话或代码</main>
<aside class="sidebar-right">检查结果</aside></div><script src="fixture.js"></script></body></html>`);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(import.meta.dirname, "sidebar-resize.acceptance.cjs"), directory],
  { env: environment, windowsHide: true, stdio: "inherit" });
const code = await new Promise((resolveCode, reject) => {
  child.once("error", reject);
  child.once("exit", (status, signal) => resolveCode(signal ? 1 : status ?? 1));
});
console.log("SIDEBAR_RESIZE_ACCEPTANCE_DIRECTORY", directory);
process.exitCode = Number(code);
