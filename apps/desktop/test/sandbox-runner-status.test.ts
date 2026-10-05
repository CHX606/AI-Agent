import { beforeEach, expect, it, vi } from "vitest";
import type { WindowsSandboxStatus } from "@anthropic-ai/sandbox-runtime";

const mocks = vi.hoisted(() => ({ status: vi.fn(), resolve: vi.fn() }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  checkWindowsSandboxStatusAsync: mocks.status, resolveSrtWin: mocks.resolve,
}));
import { brokerStatus, describeStatus } from "../../../scripts/sandbox-runner/status";
const status = (provisioned: boolean, credPresent: boolean, state: "installed" | "absent" | "cannot-read") => ({
  user: { provisioned, credPresent }, wfp: { state, filters: state === "installed" ? 8 : 0 },
}) as WindowsSandboxStatus;

beforeEach(() => { vi.clearAllMocks(); });

it.each([
  [false, false, "absent", false, "尚未安装"],
  [true, false, "installed", false, "凭据不可用"],
  [true, true, "absent", false, "过滤器缺失"],
  [true, true, "cannot-read", true, "无法枚举"],
  [true, true, "installed", true, "已就绪"],
] as const)("distinguishes account, credentials and WFP readiness", (user, creds, wfp, available, message) => {
  const result = describeStatus(status(user, creds, wfp));
  expect(result).toMatchObject({ available, backend: "anthropic-windows", version: "0.0.78" });
  expect(result.message).toContain(message);
});

it("queries only the explicit helper and reports status without installation or initialization", async () => {
  const previous = process.env.BIT_AGENT_SANDBOX_EXECUTABLE;
  process.env.BIT_AGENT_SANDBOX_EXECUTABLE = "C:/private/srt-win.exe";
  mocks.resolve.mockReturnValue({ exe: "C:/private/srt-win.exe", prependArgs: ["--srt-win"] });
  mocks.status.mockResolvedValue(status(true, true, "installed"));
  try {
    expect((await brokerStatus()).available).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledWith({ path: "C:/private/srt-win.exe" });
    expect(mocks.status).toHaveBeenCalledOnce();
    mocks.status.mockRejectedValueOnce(new Error("helper unavailable"));
    expect(await brokerStatus()).toMatchObject({ available: false, message: "Error: helper unavailable" });
  } finally {
    if (previous === undefined) delete process.env.BIT_AGENT_SANDBOX_EXECUTABLE;
    else process.env.BIT_AGENT_SANDBOX_EXECUTABLE = previous;
  }
});
