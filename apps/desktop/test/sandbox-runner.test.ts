import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(), wrap: vi.fn(), reset: vi.fn(), status: vi.fn(), install: vi.fn(), resolve: vi.fn(), child: vi.fn(), revoke: vi.fn(), restore: vi.fn(), grant: vi.fn(), expand: vi.fn(), stamp: vi.fn(),
  lock: vi.fn(), release: vi.fn(),
}));
vi.mock("../../../scripts/sandbox-runner/lock", () => ({ acquireSandboxLock: mocks.lock }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: { initialize: mocks.initialize, wrapWithSandboxArgv: mocks.wrap, reset: mocks.reset },
  checkWindowsSandboxStatusAsync: mocks.status, installWindowsSandboxAsync: mocks.install, resolveSrtWin: mocks.resolve,
  revokeWindowsAcl: mocks.revoke, restoreWindowsAcl: mocks.restore, grantWindowsAcl: mocks.grant, expandWindowsFsPaths: mocks.expand, stampWindowsAcl: mocks.stamp,
}));
vi.mock("../../../scripts/sandbox-runner/child", () => ({ runSandboxChild: mocks.child }));
import { runSandbox } from "../../../scripts/sandbox-runner/lifecycle";
import { sandboxCommand } from "../../../scripts/sandbox-runner/command";
import { outsideWorkspace, parseSandboxRequest } from "../../../scripts/sandbox-runner/request";
import { sandboxPolicy } from "../../../scripts/sandbox-runner/policy";

let directory: string, workspace: string, helper: string, broker: string;
beforeEach(() => {
  vi.resetAllMocks();
  directory = mkdtempSync(join(tmpdir(), "bit-agent-broker-"));
  workspace = join(directory, "work");
  mkdirSync(workspace);
  helper = join(directory, "srt-win.exe"); broker = join(directory, "sandbox-runner.mjs");
  writeFileSync(helper, "fixture"); writeFileSync(broker, "fixture");
  vi.stubEnv("BIT_AGENT_SANDBOX_EXECUTABLE", helper);
  mocks.resolve.mockReturnValue({ exe: helper, prependArgs: ["--srt-win"] });
  mocks.status.mockResolvedValue({ user: { provisioned: true, credPresent: true, sid: "S-1-fixture" }, wfp: { state: "installed" } });
  mocks.initialize.mockResolvedValue(undefined); mocks.reset.mockResolvedValue(undefined);
  mocks.wrap.mockResolvedValue({ argv: [helper, "exec"], env: { fixture: "value" } });
  mocks.child.mockResolvedValue(0);
  mocks.expand.mockReturnValue([join(workspace, ".env")]);
  mocks.revoke.mockReturnValue([]); mocks.restore.mockReturnValue([]);
  mocks.release.mockResolvedValue(undefined); mocks.lock.mockResolvedValue(mocks.release);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const request = () => ({ workspace, command: [process.execPath, "-e", "process.exit(0)"], readPaths: [], pythonPath: [] as string[] });

it("runs the verified helper with the official argv API then resets without reinstalling", async () => {
  expect(await runSandbox(request(), broker, new AbortController().signal)).toBe(0);
  expect(mocks.install).not.toHaveBeenCalled();
  const policy = mocks.initialize.mock.calls[0]![0];
  expect(policy.windows.srtWin.path).toBe(helper);
  expect(policy.network).toMatchObject({ allowedDomains: [], strictAllowlist: true, allowLocalBinding: false });
  expect(policy.filesystem.allowWrite).toEqual([workspace]);
  expect(mocks.wrap.mock.calls[0]![1]).toEqual(sandboxCommand(request()).shell);
  expect(mocks.child).toHaveBeenCalledWith([helper, "exec"], { fixture: "value" }, workspace, expect.any(AbortSignal));
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.reset.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.child.mock.invocationCallOrder[0]!);
});

it("installs only an absent sandbox once using the explicit helper", async () => {
  mocks.status.mockResolvedValue({ user: { provisioned: false, credPresent: false }, wfp: { state: "absent" } });
  mocks.install.mockResolvedValue({ user: { provisioned: true, credPresent: true, sid: "S-1-fixture" } });
  await runSandbox(request(), broker, new AbortController().signal);
  expect(mocks.install).toHaveBeenCalledOnce();
  expect(mocks.install).toHaveBeenCalledWith({ srtWin: { exe: helper, prependArgs: ["--srt-win"] } });
});

it("refuses partial installations without rotating existing account credentials", async () => {
  mocks.status.mockResolvedValue({ user: { provisioned: true, credPresent: false }, wfp: { state: "installed" } });
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("incomplete");
  expect(mocks.install).not.toHaveBeenCalled(); expect(mocks.initialize).not.toHaveBeenCalled();
  expect(mocks.reset).toHaveBeenCalledOnce();
});

it("refuses cancelled UAC without wrapping or launching a command", async () => {
  mocks.status.mockResolvedValue({ user: { provisioned: false, credPresent: false }, wfp: { state: "absent" } });
  mocks.install.mockResolvedValue({ cancelled: true, user: { provisioned: false, credPresent: false } });
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("cancelled");
  expect(mocks.wrap).not.toHaveBeenCalled(); expect(mocks.child).not.toHaveBeenCalled();
  expect(mocks.reset).toHaveBeenCalledOnce();
});

it("waits for initialization to settle before cancellation cleanup and never launches afterward", async () => {
  let finish!: () => void;
  mocks.initialize.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const running = runSandbox(request(), broker, controller.signal);
  const rejected = expect(running).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledOnce());
  controller.abort(new Error("cancelled"));
  expect(mocks.reset).not.toHaveBeenCalled();
  finish();
  await rejected;
  expect(mocks.wrap).not.toHaveBeenCalled(); expect(mocks.child).not.toHaveBeenCalled();
  expect(mocks.reset).toHaveBeenCalledOnce();
});

it("resets after initialization, wrapping or child failure and preserves child exit codes", async () => {
  mocks.initialize.mockRejectedValueOnce(new Error("fence unavailable"));
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("fence");
  expect(mocks.reset).toHaveBeenCalledOnce();
  mocks.wrap.mockRejectedValueOnce(new Error("wrap failed"));
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("wrap");
  mocks.child.mockRejectedValueOnce(new Error("launch failed"));
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("launch");
  mocks.child.mockResolvedValueOnce(7);
  expect(await runSandbox(request(), broker, new AbortController().signal)).toBe(7);
  expect(mocks.reset).toHaveBeenCalledTimes(4);
});

it("accepts python import roots only inside the workspace and passes them as PYTHONPATH", () => {
  const source = join(workspace, "src");
  expect(parseSandboxRequest(JSON.stringify({ ...request(), pythonPath: [source, workspace] })).pythonPath).toEqual([source, workspace]);
  expect(() => parseSandboxRequest(JSON.stringify({ ...request(), pythonPath: [directory] }))).toThrow("inside the workspace");
  expect(() => parseSandboxRequest(JSON.stringify({ ...request(), pythonPath: [join(workspace, "..", "other")] }))).toThrow("inside the workspace");
  const invocation = sandboxCommand({ workspace, pythonPath: [source, workspace], command: [
    process.execPath, "-e", "process.stdout.write(process.env.PYTHONPATH ?? '')",
  ] });
  const result = spawnSync(invocation.shell.exe, [...invocation.shell.args, invocation.command], { encoding: "utf8" });
  expect(result.stdout).toBe(`${source};${workspace}`);
});

it("validates the complete request and rejects batch shell metacharacters", () => {
  expect(parseSandboxRequest(JSON.stringify(request()))).toEqual(request());
  const { pythonPath: _omitted, ...older } = request();
  expect(parseSandboxRequest(JSON.stringify(older))).toEqual(request());
  expect(() => parseSandboxRequest(JSON.stringify({ ...request(), command: "python" }))).toThrow();
  expect(() => parseSandboxRequest(JSON.stringify({ ...request(), readPaths: [3] }))).toThrow();
  expect(() => parseSandboxRequest(JSON.stringify({ ...request(), extra: true }))).toThrow("fields");
  expect(() => parseSandboxRequest(JSON.stringify({ ...request(), command: ["C:/bin/tool.cmd", "ok&echo injected"] }))).toThrow("metacharacters");
  expect(() => parseSandboxRequest(JSON.stringify({ ...request(), command: ["C:/bin/tool.bat", "%SECRET%"] }))).toThrow("metacharacters");
  expect(() => parseSandboxRequest(JSON.stringify({ ...request(), command: ["relative.exe"] }))).toThrow("absolute");
});

it("keeps native argv and cwd as base64 JSON data inside a fixed Node command", () => {
  const command = [process.execPath, "-e", "process.exit(0)", "'; Write-Output injected", "中文", "$env:SECRET", "a&b"];
  const invocation = sandboxCommand({ workspace, command });
  const payload = /Buffer.from\("([A-Za-z0-9+/=]+)","base64"\)/u.exec(invocation.command)![1]!;
  expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual({ workspace, command });
  expect(invocation.shell).toEqual({ exe: process.execPath, args: ["-e"] });
  expect(invocation.command).toContain("shell:false");
  expect(invocation.command).not.toContain("Write-Output injected");
});

it("protects runtime binaries, git metadata, dependencies and keys within a writable workspace", () => {
  const policy = sandboxPolicy({ ...request(), readPaths: [join(directory, "python")] }, helper, broker);
  expect(policy.filesystem.allowWrite).toEqual([workspace]);
  expect(policy.filesystem.allowRead).toContain(directory);
  expect(policy.filesystem.denyWrite).toContain(directory);
  expect(policy.filesystem.denyWrite.some((p: string) => p.endsWith("**\\.git"))).toBe(true);
  expect(policy.filesystem.denyRead.some((p: string) => p.endsWith("**\\*.pem"))).toBe(true);
  expect(() => outsideWorkspace(workspace, workspace)).toThrow("outside");
});

it("keeps agent and editor configuration read-only, including a not-yet-created verification config", () => {
  const { denyWrite } = sandboxPolicy(request(), helper, broker).filesystem;
  for (const name of [".bit-agent", ".codex", ".agents", ".claude", ".vscode", ".idea", ".mcp.json"]) {
    expect(denyWrite).toContain(join(workspace, "**", name));
  }
  // 结尾分隔符让官方 SDK 在目录不存在时用空目录占位，测试无法新建 verify.json 绕过审批。
  expect(denyWrite).toContain(join(workspace, ".bit-agent") + "\\");
});

it("holds the machine-wide sandbox lock from installation checks until ACL cleanup finishes", async () => {
  await runSandbox(request(), broker, new AbortController().signal);
  expect(mocks.lock).toHaveBeenCalledOnce();
  expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.status.mock.invocationCallOrder[0]!);
  expect(mocks.release.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.reset.mock.invocationCallOrder[0]!);
  mocks.initialize.mockRejectedValueOnce(new Error("fence unavailable"));
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("fence");
  expect(mocks.release).toHaveBeenCalledTimes(2);
});

it("round-trips complex native argv and the selected cwd through real Node process spawning", () => {
  const nested = "import os, subprocess, sys, time; child=subprocess.Popen([sys.executable, '-c', \"from pathlib import Path; print('child started')\"]); child.wait()";
  const expected = ["", "plain arg", "中文", "'; Write-Output injected", "$env:SECRET", "a&b", 'quote"inside', 'a\\\"b', "C:\\foo bar\\", "ends\\", "line\nbreak", nested];
  const invocation = sandboxCommand({ workspace, command: [
    process.execPath, "-e", "process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),encoding:process.env.PYTHONIOENCODING}))", ...expected,
  ] });
  const result = spawnSync(invocation.shell.exe, [...invocation.shell.args, invocation.command],
    { encoding: "utf8", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ argv: expected, cwd: workspace, encoding: "utf-8" });
});

it("keeps batch commands in the encoded PowerShell branch with an explicit cwd", () => {
  const program = join(workspace, "show-cwd.cmd");
  writeFileSync(program, "@echo off\r\ncd\r\n");
  const invocation = sandboxCommand({ workspace, command: [program] });
  const decoded = Buffer.from(invocation.command, "base64").toString("utf16le");
  expect(decoded).toContain("Set-Location -LiteralPath $task.workspace");
  expect(decoded).toContain("$ProgressPreference='SilentlyContinue'");
  const result = spawnSync(invocation.shell.exe, [...invocation.shell.args, invocation.command],
    { encoding: "utf8", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(workspace);
});

it("grants only trusted runtime reads before official WFP initialization and releases them on failure", async () => {
  mocks.initialize.mockRejectedValueOnce(new Error("WFP probe rejected"));
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("WFP probe");
  expect(mocks.grant).toHaveBeenCalledWith({
    sandboxUserSid: "S-1-fixture", srtWin: { exe: helper, prependArgs: ["--srt-win"] },
    read: expect.arrayContaining([directory]), write: [],
  });
  expect(mocks.grant.mock.invocationCallOrder[0]).toBeLessThan(mocks.initialize.mock.invocationCallOrder[0]!);
  expect(mocks.revoke).toHaveBeenCalledOnce(); expect(mocks.restore).toHaveBeenCalledOnce();
  expect(mocks.reset).toHaveBeenCalledOnce();
});

it("does not report verified cleanup when official ACL release has anomalies or fails to return results", async () => {
  mocks.revoke.mockReturnValueOnce([{ path: "fixture", status: "accessDenied" }]);
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("BIT_AGENT_SANDBOX_CLEANUP_ERROR");
  expect(mocks.restore).toHaveBeenCalledOnce(); expect(mocks.reset).toHaveBeenCalledOnce();
  mocks.restore.mockReturnValueOnce(undefined);
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("verifiable results");
  expect(mocks.reset).toHaveBeenCalledTimes(2);
});

it("reasserts full read denies after initialization and before wrapping any task", async () => {
  await runSandbox(request(), broker, new AbortController().signal);
  expect(mocks.expand).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining("**\\.env")]), { mode: "deny" });
  expect(mocks.stamp).toHaveBeenCalledWith({
    sandboxUserSid: "S-1-fixture", srtWin: { exe: helper, prependArgs: ["--srt-win"] },
    denyRead: [join(workspace, ".env")], denyWrite: [],
  });
  expect(mocks.stamp.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.initialize.mock.invocationCallOrder[0]!);
  expect(mocks.wrap.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.stamp.mock.invocationCallOrder[0]!);
  mocks.stamp.mockImplementationOnce(() => { throw new Error("read deny could not be verified"); });
  await expect(runSandbox(request(), broker, new AbortController().signal)).rejects.toThrow("read deny");
  expect(mocks.wrap).toHaveBeenCalledOnce(); expect(mocks.child).toHaveBeenCalledOnce();
  expect(mocks.revoke).toHaveBeenCalledTimes(2); expect(mocks.restore).toHaveBeenCalledTimes(2);
});
