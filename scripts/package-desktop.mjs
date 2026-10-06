// 生成独立便携目录。只写入一个全新目录，不覆盖已有发布包或用户数据。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { bundleSandbox } from "./desktop-package/sandbox.mjs";
import { applyWindowsBranding } from "./desktop-package/windows-branding.mjs";

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
const resources = join(output, "resources");
const app = join(resources, "app");
mkdirSync(app, { recursive: true });
cpSync(join(desktop, "dist"), join(app, "dist"), { recursive: true });
// 版本号以桌面端 package.json 为准，界面“个人中心”里显示的就是它（app.getVersion）。
const { version } = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "bit-agent", version, type: "module", main: "dist/main/main/main.js" }));
const branding = applyWindowsBranding(output, { version });

const esbuildDirectory = readdirSync(join(root, "node_modules", ".pnpm")).find((name) => /^esbuild@/u.test(name));
if (!esbuildDirectory) throw new Error("缺少 esbuild，请先安装项目依赖");
const esbuild = await import(pathToFileURL(join(root, "node_modules", ".pnpm", esbuildDirectory, "node_modules", "esbuild", "lib", "main.js")).href);
// Bundle main-process workspace adapters and their mature logging/ZIP dependencies as well.
await esbuild.build({ entryPoints: [join(desktop, "src", "main", "main.ts")], bundle: true,
  outfile: join(app, "dist", "main", "main", "main.js"), platform: "node", format: "esm",
  external: ["electron", "node-pty"], target: "node24",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
// 内置终端的原生模块不能打进单文件，只复制运行需要的部分：JS、Windows x64 预编译文件（不含调试符号）。
const nodePty = dirname(require.resolve("node-pty/package.json"));
const packagedPty = join(app, "node_modules", "node-pty");
cpSync(join(nodePty, "package.json"), join(packagedPty, "package.json"));
cpSync(join(nodePty, "lib"), join(packagedPty, "lib"), { recursive: true,
  filter: (path) => !/\.(test\.js|map)$/u.test(path) });
cpSync(join(nodePty, "prebuilds", "win32-x64"), join(packagedPty, "prebuilds", "win32-x64"), { recursive: true,
  filter: (path) => !path.endsWith(".pdb") });
await esbuild.build({ entryPoints: [join(root, "scripts", "gateway-entry.ts")], bundle: true,
  outfile: join(resources, "gateway", "index.mjs"), platform: "node", format: "esm", target: "node24",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

await bundleSandbox(resources);

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
// 同时携带锁定版本的Python验证工具；项目自己的依赖仍使用项目环境。
// 测试和检查通过官方Windows OS沙箱执行。
const lockExport = mkdtempSync(join(tmpdir(), "bit-agent-package-"));
try {
  const requirements = join(lockExport, "runtime-requirements.txt");
  const uv = (args) => execFileSync("uv", args, { cwd: root, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, UV_LINK_MODE: "copy" } });
  uv(["export", "--frozen", "--no-dev", "--extra", "memory", "--extra", "verification", "--no-emit-project",
    "--format", "requirements-txt", "--output-file", requirements]);
  uv(["pip", "install", "--no-deps", "--python", join(basePython, "python.exe"),
    "--target", join(python, "Lib", "site-packages"), "--requirement", requirements]);
} finally {
  rmSync(lockExport, { recursive: true, force: true });
}
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
// 沙箱加固脚本放在发布目录根部，只用便携包的人也能运行（说明见 docs/ENVIRONMENT.md）。
cpSync(join(root, "scripts", "harden-sandbox.ps1"), join(output, "harden-sandbox.ps1"));
writeFileSync(join(output, "README.txt"), [
  "Bit Agent Windows portable", "Run Bit Agent.exe. Keep the entire folder together.",
  "Node, Python, Gateway, Git apply and ripgrep are bundled. No system Python/Node required.",
  "Configure your model in the application. Keys are encrypted by Windows.",
  "Official Anthropic Windows OS sandbox SDK 0.0.78 (alpha) is bundled. First verification may request Windows elevation to install its dedicated sandbox account and network fence. Project dependencies/toolchains must already be installed.",
  "Folders Windows opens to all users (e.g. D:\\ by default) stay writable by the sandbox account until hardened: run harden-sandbox.ps1 as administrator with -Apply (preview without it, undo with -Remove).",
  "This is an unsigned development build, not a signed installer. Windows may show a warning.",
  "User data is stored outside this folder; replacing this release does not delete sessions.",
  "Dependency license files are retained with their installed packages. Git is GPLv2; Electron includes LICENSE and LICENSES.chromium.html.",
].join("\r\n"));
writeFileSync(join(output, "build-info.json"), JSON.stringify({ createdAt: new Date().toISOString(),
  platform: process.platform, arch: process.arch, python: basePython, independentRuntime: true,
  externalRequirements: ["model API", "project dependencies/toolchains", "first-use Windows sandbox setup"], sandbox: { engine: "@anthropic-ai/sandbox-runtime", version: "0.0.78", windowsSupport: "alpha" },
  applicationIcon: "resources/app/assets/icon.ico", appUserModelId: "BitAgent.Desktop",
}, null, 2));
console.log(JSON.stringify({ output, executable: branding.executable }));
