// 生成独立便携目录。只写入一个全新目录，不覆盖已有发布包或用户数据。
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") throw new Error("当前打包脚本只构建 Windows 便携版");
const root = resolve(import.meta.dirname, "..");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const output = join(root, "release", `BitAgent-${stamp}`);
if (existsSync(output)) throw new Error("输出目录已存在，拒绝覆盖");
mkdirSync(output, { recursive: true });
const desktop = join(root, "apps", "desktop");
const require = createRequire(join(desktop, "package.json"));
const electron = dirname(require("electron"));
cpSync(electron, output, { recursive: true });
// Electron 原始可执行程序可直接作为入口；额外提供明确的产品名称。
cpSync(join(output, "electron.exe"), join(output, "Bit Agent.exe"));
const resources = join(output, "resources");
const app = join(resources, "app");
mkdirSync(app, { recursive: true });
cpSync(join(desktop, "dist"), join(app, "dist"), { recursive: true });
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "bit-agent", version: "0.1.0", type: "module", main: "dist/main/main/main.js" }));

const esbuildDirectory = readdirSync(join(root, "node_modules", ".pnpm")).find((name) => /^esbuild@/u.test(name));
if (!esbuildDirectory) throw new Error("缺少 esbuild，请先安装项目依赖");
const esbuild = await import(pathToFileURL(join(root, "node_modules", ".pnpm", esbuildDirectory, "node_modules", "esbuild", "lib", "main.js")).href);
// Bundle main-process workspace adapters and their mature logging/ZIP dependencies as well.
await esbuild.build({ entryPoints: [join(desktop, "src", "main", "main.ts")], bundle: true,
  outfile: join(app, "dist", "main", "main", "main.js"), platform: "node", format: "esm",
  external: ["electron"], target: "node24",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
await esbuild.build({ entryPoints: [join(root, "scripts", "gateway-entry.ts")], bundle: true,
  outfile: join(resources, "gateway", "index.mjs"), platform: "node", format: "esm", target: "node24",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

const sourcePython = join(root, ".venv", "Scripts", "python.exe");
const basePython = execFileSync(sourcePython, ["-c", "import sys; print(sys.base_prefix)"], { encoding: "utf8" }).trim();
const python = join(resources, "python");
mkdirSync(python, { recursive: true });
for (const file of readdirSync(basePython)) {
  if (/^(python.*\.(exe|dll)|vcruntime.*\.dll|LICENSE.*)$/iu.test(file)) cpSync(join(basePython, file), join(python, file));
}
for (const directory of ["Lib", "DLLs"]) cpSync(join(basePython, directory), join(python, directory), {
  recursive: true, filter: (path) => !["site-packages", "__pycache__", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip"].includes(path.split(/[\\/]/u).at(-1)),
});
cpSync(join(root, ".venv", "Lib", "site-packages"), join(python, "Lib", "site-packages"), {
  recursive: true, filter: (path) => !["__pycache__", ".pytest_cache"].includes(path.split(/[\\/]/u).at(-1)) && !path.split(/[\\/]/u).at(-1).startsWith("__editable__"),
});
const backend = join(resources, "backend", "services", "agent", "src");
cpSync(join(root, "services", "agent", "src"), backend, { recursive: true,
  filter: (path) => !["__pycache__"].includes(path.split(/[\\/]/u).at(-1)),
});
writeFileSync(join(python, "python312._pth"), "Lib\nDLLs\nLib/site-packages\n../backend/services/agent/src\nimport site\n");
const tools = join(resources, "tools");
mkdirSync(tools, { recursive: true });
const gitCommand = execFileSync("where.exe", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/u)[0];
const gitRoot = dirname(dirname(gitCommand));
const gitBin = join(gitRoot, "mingw64", "bin");
for (const file of readdirSync(gitBin)) {
  if (file === "git.exe" || file.endsWith(".dll")) cpSync(join(gitBin, file), join(tools, file));
}
cpSync(join(gitRoot, "LICENSE.txt"), join(tools, "GIT-LICENSE.txt"));
const configuredRg = process.env.BIT_AGENT_RG_PATH?.trim();
const rg = configuredRg && existsSync(configuredRg)
  ? configuredRg
  : execFileSync("where.exe", ["rg"], { encoding: "utf8" }).trim().split(/\r?\n/u)[0];
cpSync(rg, join(tools, "rg.exe"));
writeFileSync(join(output, "README.txt"), [
  "Bit Agent Windows portable", "Run Bit Agent.exe. Keep the entire folder together.",
  "Node, Python, Gateway, Git apply and ripgrep are bundled. No system Python/Node required.",
  "Configure your model in the application. Keys are encrypted by Windows.",
  "Docker Desktop and sandbox images are still required to execute isolated project verification.",
  "This is an unsigned development build, not a signed installer. Windows may show a warning.",
  "User data is stored outside this folder; replacing this release does not delete sessions.",
  "Dependency license files are retained with their installed packages. Git is GPLv2; Electron includes LICENSE and LICENSES.chromium.html.",
].join("\r\n"));
writeFileSync(join(output, "build-info.json"), JSON.stringify({ createdAt: new Date().toISOString(),
  platform: process.platform, arch: process.arch, python: basePython, independentRuntime: true,
  externalRequirements: ["model API", "Docker for isolated verification"],
}, null, 2));
console.log(JSON.stringify({ output, executable: join(output, "Bit Agent.exe") }));
