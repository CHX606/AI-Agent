import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const directory = mkdtempSync(join(root, "tmp", "markdown-renderer-"));
const require = createRequire(join(root, "apps", "desktop", "package.json"));
const esbuildDirectory = readdirSync(join(root, "node_modules", ".pnpm")).find(name => /^esbuild@/u.test(name));
if (!esbuildDirectory) throw new Error("缺少项目已有的 esbuild 依赖");
const esbuild = await import(pathToFileURL(join(root, "node_modules", ".pnpm", esbuildDirectory,
  "node_modules", "esbuild", "lib", "main.js")).href);
await esbuild.build({ entryPoints: [join(import.meta.dirname, "markdown-renderer.fixture.ts")], bundle: true,
  outfile: join(directory, "fixture.js"), platform: "browser", format: "iife", target: "chrome140" });
writeFileSync(join(directory, "index.html"), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css"><style>
body{height:auto;overflow:auto;padding:24px;background:var(--bg-main)}
#fixture{max-width:900px;margin:auto}.markdown-body{font-size:15px}#stream{margin-top:24px}
</style></head><body><main id="fixture"><section id="rendered" class="markdown-body"></section>
<ol id="stream" class="stream"></ol></main><script src="fixture.js"></script></body></html>`);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(import.meta.dirname, "markdown-renderer.acceptance.cjs"), directory],
  { env: environment, windowsHide: true, stdio: "inherit" });
const code = await new Promise((resolveCode, reject) => {
  child.once("error", reject);
  child.once("exit", (status, signal) => resolveCode(signal ? 1 : status ?? 1));
});
console.log("MARKDOWN_RENDERER_ACCEPTANCE_DIRECTORY", directory);
process.exitCode = Number(code);
