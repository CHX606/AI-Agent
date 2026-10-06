import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const directory = mkdtempSync(join(root, "tmp", "stream-renderer-"));
const require = createRequire(join(root, "apps", "desktop", "package.json"));
const esbuildDirectory = readdirSync(join(root, "node_modules", ".pnpm")).find(name => /^esbuild@/u.test(name));
if (!esbuildDirectory) throw new Error("缺少项目已有的 esbuild 依赖");
const esbuild = await import(pathToFileURL(join(root, "node_modules", ".pnpm", esbuildDirectory,
  "node_modules", "esbuild", "lib", "main.js")).href);
await esbuild.build({ entryPoints: [join(import.meta.dirname, "stream-renderer.fixture.ts")], bundle: true,
  outfile: join(directory, "fixture.js"), platform: "browser", format: "iife", target: "chrome140" });
writeFileSync(join(directory, "index.html"), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css"><style>
:root{--text:#eee;--text-muted:#aaa;--text-soft:#ddd;--text-faint:#777;--border:#393939;
--red:#e66;--green:#8b8;--amber:#eaa45b;--bg-panel:#252525;--font-mono:monospace}
body{padding:24px;background:#1c1c1a;color:#eee}.stream{max-width:960px}
</style></head><body><ol id="stream" class="stream"></ol><script src="fixture.js"></script></body></html>`);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(import.meta.dirname, "stream-renderer.acceptance.cjs"), directory],
  { env: environment, windowsHide: true, stdio: "inherit" });
const code = await new Promise((resolveCode, reject) => {
  child.once("error", reject);
  child.once("exit", (status, signal) => resolveCode(signal ? 1 : status ?? 1));
});
console.log("STREAM_RENDERER_ACCEPTANCE_DIRECTORY", directory);
process.exitCode = Number(code);
