import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const version = "0.0.78";
const names = ["node.exe", "sandbox-runner.mjs", "srt-win.exe"];

async function bundler() {
  const directory = readdirSync(join(root, "node_modules/.pnpm")).find(name => /^esbuild@/u.test(name));
  if (!directory) throw new Error("Missing existing workspace esbuild dependency");
  return import(pathToFileURL(join(root, "node_modules/.pnpm", directory, "node_modules/esbuild/lib/main.js")).href);
}

export async function bundleSandbox(resources) {
  if (process.platform !== "win32") throw new Error("The portable sandbox requires Windows");
  const require = createRequire(join(root, "package.json"));
  const sdk = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
  const metadata = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
  if (metadata.version !== version) throw new Error("Sandbox SDK version differs from pinned manifest");
  const target = join(resources, "sandbox");
  mkdirSync(target, { recursive: true });
  cpSync(process.execPath, join(target, "node.exe"));
  cpSync(join(sdk, "vendor/srt-win", process.arch, "srt-win.exe"), join(target, "srt-win.exe"));
  cpSync(join(sdk, "LICENSE"), join(target, "ANTHROPIC-SANDBOX-LICENSE.txt"));
  const esbuild = await bundler();
  await esbuild.build({ entryPoints: [join(root, "scripts/sandbox-runner.ts")], bundle: true,
    outfile: join(target, "sandbox-runner.mjs"), platform: "node", format: "esm", target: "node24",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  const files = Object.fromEntries(names.map(name => [name,
    createHash("sha256").update(readFileSync(join(target, name))).digest("hex")]));
  writeFileSync(join(target, "sandbox-manifest.json"), JSON.stringify({ version, files }, null, 2));
  return target;
}

export async function developmentSandbox(resources) {
  await bundleSandbox(resources);
  const module = join(root, "apps/desktop/dist/main/main/infrastructure/runtime/sandbox-executor.js");
  const { prepareSandboxExecutor } = await import(pathToFileURL(module).href);
  if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required for the trusted executor cache");
  const executor = await prepareSandboxExecutor(resources, join(process.env.LOCALAPPDATA, "BitAgent"));
  return { BIT_AGENT_SANDBOX_NODE: executor.node, BIT_AGENT_SANDBOX_BROKER: executor.broker,
    BIT_AGENT_SANDBOX_EXECUTABLE: executor.executable };
}
