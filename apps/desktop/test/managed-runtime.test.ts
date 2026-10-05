import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getPath: vi.fn(), getVersion: vi.fn(() => "1.0.0") },
  environment: vi.fn(), spawn: vi.fn(), record: vi.fn(), failure: vi.fn(() => "fixture-diagnostic"),
}));
vi.mock("electron", () => ({ app: mocks.app, net: {}, safeStorage: {} }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/main/infrastructure/runtime/gateway-environment", () => ({ createGatewayEnvironment: mocks.environment }));
vi.mock("../src/main/infrastructure/observability/diagnostics", () => ({
  desktopDiagnostics: () => ({ record: mocks.record, failure: mocks.failure }),
}));
vi.mock("../src/main/infrastructure/runtime/mcp-settings", () => ({
  decryptedMcpServers: () => [], mcpServerList: vi.fn(), resolveMcpServers: vi.fn(), writeMcpServers: vi.fn(),
}));

let directory: string;
const resourceDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "bit-agent-managed-runtime-"));
  mocks.app.isPackaged = true;
  mocks.app.getPath.mockReturnValue(directory);
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: join(directory, "resources") });
  mocks.environment.mockResolvedValue({
    ELECTRON_RUN_AS_NODE: "1", BIT_AGENT_SANDBOX_EXECUTABLE: join(directory, "sandbox-executor", "0.0.78", "srt-win.exe"),
    BIT_AGENT_SANDBOX_NODE: join(directory, "sandbox-executor", "0.0.78", "node.exe"),
    BIT_AGENT_SANDBOX_BROKER: join(directory, "sandbox-executor", "0.0.78", "sandbox-runner.mjs"),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (resourceDescriptor) Object.defineProperty(process, "resourcesPath", resourceDescriptor);
  else Reflect.deleteProperty(process, "resourcesPath");
  rmSync(directory, { recursive: true, force: true });
});

it("rejects packaged startup before spawning Gateway when sandbox preparation fails", async () => {
  mocks.environment.mockRejectedValueOnce(new Error("随包沙箱执行器 SHA256 校验失败"));
  const runtime = await import("../src/main/infrastructure/runtime/managed-runtime");
  await expect(runtime.startManagedRuntime()).rejects.toThrow("SHA256 校验失败");
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(runtime.runtimeConfiguration().gatewayUrl).toBe("");
  await runtime.stopManagedRuntime();
});

it("leaves development startup unchanged and does not prepare or launch bundled services", async () => {
  mocks.app.isPackaged = false;
  const runtime = await import("../src/main/infrastructure/runtime/managed-runtime");
  await runtime.startManagedRuntime();
  expect(mocks.environment).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("launches only Gateway with the prepared environment and preserves readiness and shutdown", async () => {
  const fake = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, kill: vi.fn(),
  });
  fake.stdin.once("finish", () => { fake.exitCode = 0; fake.emit("exit", 0, null); });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => fake.stdout.write(JSON.stringify({ gatewayUrl: "http://127.0.0.1:43879" }) + "\n"));
    return fake;
  });
  const runtime = await import("../src/main/infrastructure/runtime/managed-runtime");
  await runtime.startManagedRuntime();
  expect(mocks.environment).toHaveBeenCalledWith({
    resources: join(directory, "resources"), userData: directory, data: join(directory, "runtime"),
    token: expect.any(String), settings: { baseUrl: "", model: "", api: "responses", configured: false }, mcp: [],
  });
  expect(mocks.spawn).toHaveBeenCalledOnce();
  const [executable, args, options] = mocks.spawn.mock.calls[0]!;
  expect(executable).toBe(process.execPath);
  expect(args).toEqual([join(directory, "resources", "gateway", "index.mjs")]);
  expect(options.env.BIT_AGENT_SANDBOX_EXECUTABLE).toBe(join(directory, "sandbox-executor", "0.0.78", "srt-win.exe"));
  expect(options.env.BIT_AGENT_SANDBOX_NODE).toBe(join(directory, "sandbox-executor", "0.0.78", "node.exe"));
  expect(options.env.BIT_AGENT_SANDBOX_BROKER).toBe(join(directory, "sandbox-executor", "0.0.78", "sandbox-runner.mjs"));
  expect(options.windowsHide).toBe(true);
  expect(runtime.runtimeConfiguration().gatewayUrl).toBe("http://127.0.0.1:43879");
  await runtime.stopManagedRuntime();
  expect(fake.stdin.writableEnded).toBe(true);
  expect(runtime.runtimeConfiguration().gatewayUrl).toBe("");
  fake.stdout.destroy(); fake.stderr.destroy(); fake.stdin.destroy();
});
