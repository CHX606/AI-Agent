import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayEnvironment } from "../src/main/infrastructure/runtime/gateway-environment";
import { prepareSandboxExecutor } from "../src/main/infrastructure/runtime/sandbox-executor";
import { parseSandboxManifest, sandboxFiles, sandboxVersion } from "../src/main/infrastructure/runtime/sandbox-manifest";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bit-agent-sandbox-executor-"));
  directories.push(directory);
  const resources = join(directory, "resources");
  const bundled = join(resources, "sandbox");
  const userData = join(directory, "profile");
  mkdirSync(bundled, { recursive: true });
  mkdirSync(userData);
  const files = Object.fromEntries(sandboxFiles.map(name => {
    const bytes = Buffer.from("official fixture " + name);
    writeFileSync(join(bundled, name), bytes);
    return [name, createHash("sha256").update(bytes).digest("hex")];
  }));
  const manifest = { version: sandboxVersion, files };
  const manifestPath = join(bundled, "sandbox-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { directory, resources, bundled, userData, manifest, manifestPath,
    cache: join(userData, "sandbox-executor", sandboxVersion) };
}
afterEach(() => { vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("prepares verified executables and private state outside the bundle without running commands", async () => {
  const view = fixture();
  const sandbox = await prepareSandboxExecutor(view.resources, view.userData);
  expect(sandbox).toEqual({ executable: join(view.cache, "srt-win.exe"), node: join(view.cache, "node.exe"), broker: join(view.cache, "sandbox-runner.mjs") });
  for (const name of sandboxFiles) expect(readFileSync(join(view.cache, name))).toEqual(readFileSync(join(view.bundled, name)));
  expect(readdirSync(view.userData)).toEqual(["sandbox-executor"]);
  expect(readdirSync(view.cache).sort()).toEqual([...sandboxFiles].sort());
});

it("reuses matching cache files without copying them again", async () => {
  const view = fixture();
  await prepareSandboxExecutor(view.resources, view.userData);
  const old = new Date("2001-01-01T00:00:00.000Z");
  for (const name of sandboxFiles) utimesSync(join(view.cache, name), old, old);
  await prepareSandboxExecutor(view.resources, view.userData);
  for (const name of sandboxFiles) expect(statSync(join(view.cache, name)).mtimeMs).toBe(old.getTime());
});

it("repairs corrupted cache files from verified bundled bytes and removes temporary files", async () => {
  const view = fixture();
  await prepareSandboxExecutor(view.resources, view.userData);
  writeFileSync(join(view.cache, "srt-win.exe"), "changed");
  await prepareSandboxExecutor(view.resources, view.userData);
  expect(readFileSync(join(view.cache, "srt-win.exe"))).toEqual(readFileSync(join(view.bundled, "srt-win.exe")));
  expect(readdirSync(view.cache).some(name => name.endsWith(".tmp"))).toBe(false);
});

it("rejects a changed bundled helper even when a valid cache already exists", async () => {
  const view = fixture();
  await prepareSandboxExecutor(view.resources, view.userData);
  writeFileSync(join(view.bundled, "sandbox-runner.mjs"), "changed helper");
  await expect(prepareSandboxExecutor(view.resources, view.userData)).rejects.toThrow("SHA256 校验失败");
});

it("rejects missing bundled files without substituting a system executable", async () => {
  const view = fixture();
  rmSync(join(view.bundled, "srt-win.exe"));
  vi.stubEnv("BIT_AGENT_SANDBOX_EXECUTABLE", "C:/unverified/srt-win.exe");
  await expect(prepareSandboxExecutor(view.resources, view.userData)).rejects.toThrow("srt-win.exe");
  expect(readdirSync(view.userData)).toEqual([]);
});

type FixtureManifest = ReturnType<typeof fixture>["manifest"];
it.each([
  (value: FixtureManifest) => ({ ...value, version: "0.0.77" }),
  (value: FixtureManifest) => ({ ...value, executable: "system-codex" }),
  (value: FixtureManifest) => ({ ...value, files: { ...value.files, "../srt-win.exe": value.files["srt-win.exe"] } }),
  (value: FixtureManifest) => ({ ...value, files: { ...value.files, "srt-win.exe": "invalid" } }),
])("rejects unsupported manifest versions, names and digests", change => {
  const view = fixture();
  expect(() => parseSandboxManifest(change(view.manifest))).toThrow();
});

it("refuses a private cache directory redirected by a junction", async () => {
  const view = fixture();
  const redirected = join(view.directory, "workspace");
  mkdirSync(redirected);
  symlinkSync(redirected, join(view.userData, "sandbox-executor"), "junction");
  await expect(prepareSandboxExecutor(view.resources, view.userData)).rejects.toThrow("不能是链接");
  expect(readdirSync(redirected)).toEqual([]);
});

it("allows concurrent startups to publish only complete verified cache files", async () => {
  const view = fixture();
  const results = await Promise.all([
    prepareSandboxExecutor(view.resources, view.userData), prepareSandboxExecutor(view.resources, view.userData),
  ]);
  expect(results[0]).toEqual(results[1]);
  for (const name of sandboxFiles) expect(readFileSync(join(view.cache, name))).toEqual(readFileSync(join(view.bundled, name)));
  expect(readdirSync(view.cache).sort()).toEqual([...sandboxFiles].sort());
});

it("injects only verified sandbox paths while preserving gateway, model and external tool settings", async () => {
  const view = fixture();
  vi.stubEnv("BIT_AGENT_SANDBOX_EXECUTABLE", "C:/unverified/srt-win.exe");
  vi.stubEnv("BIT_AGENT_SANDBOX_HOME", "C:/workspace");
  const env = await createGatewayEnvironment({ resources: view.resources, userData: view.userData,
    data: join(view.userData, "runtime"), token: "fixture-token",
    settings: { apiKey: "fixture-key", baseUrl: "https://fixture.invalid", model: "fixture-model",
      api: "chat_completions", auxModel: "aux-fixture" }, mcp: [{ name: "fixture-tool" }] });
  expect(env.BIT_AGENT_SANDBOX_EXECUTABLE).toBe(join(view.cache, "srt-win.exe"));
  expect(env.BIT_AGENT_SANDBOX_HOME).toBeUndefined();
  expect(env.BIT_AGENT_SANDBOX_NODE).toBe(join(view.cache, "node.exe"));
  expect(env.BIT_AGENT_SANDBOX_BROKER).toBe(join(view.cache, "sandbox-runner.mjs"));
  expect(env.BIT_AGENT_GATEWAY_TOKEN).toBe("fixture-token");
  expect(env.API_KEY).toBe("fixture-key");
  expect(env.BASE_URL).toBe("https://fixture.invalid");
  expect(env.MODEL_NAME).toBe("fixture-model");
  expect(env.MODEL_API).toBe("chat_completions");
  expect(env.AUX_MODEL_NAME).toBe("aux-fixture");
  expect(JSON.parse(env.BIT_AGENT_MCP_SERVERS!)).toEqual([{ name: "fixture-tool" }]);
  expect(env.BIT_AGENT_PYTHON).toBe(join(view.resources, "python", "python.exe"));
  expect(env.PATH!.split(process.platform === "win32" ? ";" : ":")[0]).toBe(join(view.resources, "tools"));
});
