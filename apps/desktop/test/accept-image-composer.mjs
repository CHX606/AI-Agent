import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const directory = mkdtempSync(join(root, "tmp", "image-composer-"));
const require = createRequire(join(root, "apps", "desktop", "package.json"));
const esbuildDirectory = readdirSync(join(root, "node_modules", ".pnpm")).find(name => /^esbuild@/u.test(name));
if (!esbuildDirectory) throw new Error("缺少项目已有的 esbuild 依赖");
const esbuild = await import(pathToFileURL(join(root, "node_modules", ".pnpm", esbuildDirectory,
  "node_modules", "esbuild", "lib", "main.js")).href);
await esbuild.build({ entryPoints: [join(import.meta.dirname, "image-composer.fixture.ts")], bundle: true,
  outfile: join(directory, "fixture.js"), platform: "browser", format: "iife", target: "chrome140" });
writeFileSync(join(directory, "index.html"), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css"><style>body{height:auto;overflow:auto;padding:24px}
.composer-card{margin:20px auto}.turn{padding:18px 0}</style></head><body data-busy="true">
<div class="composer-card"><textarea class="composer-textarea" rows="1"></textarea><div class="composer-toolbar"><div class="composer-actions"></div></div></div>
<div id="previous-turns"></div><div id="metadata"></div><script src="fixture.js"></script></body></html>`);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(import.meta.dirname, "image-composer.acceptance.cjs"), directory],
  { env: environment, windowsHide: true, stdio: "inherit" });
const code = await new Promise((resolveCode, reject) => {
  child.once("error", reject);
  child.once("exit", (status, signal) => resolveCode(signal ? 1 : status ?? 1));
});
console.log("IMAGE_COMPOSER_ACCEPTANCE_DIRECTORY", directory);
process.exitCode = Number(code);
