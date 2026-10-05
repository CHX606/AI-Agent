import {
  SandboxManager, checkWindowsSandboxStatusAsync, installWindowsSandboxAsync, resolveSrtWin,
} from "@anthropic-ai/sandbox-runtime";
import { bootstrapRuntimeReads } from "./bootstrap.js";
import { sandboxCommand } from "./command.js";
import { resetSandbox } from "./cleanup.js";
import { runSandboxChild } from "./child.js";
import { sandboxPolicy } from "./policy.js";
import { acquireSandboxLock } from "./lock.js";
import { enforceReadDenials } from "./read-protection.js";
import { outsideWorkspace, type SandboxRequest } from "./request.js";

async function ensureInstallation(helper: string, signal: AbortSignal): Promise<string> {
  const srtWin = resolveSrtWin({ path: helper });
  const status = await checkWindowsSandboxStatusAsync({ srtWin });
  signal.throwIfAborted();
  if (status.user.provisioned && status.user.credPresent) {
    if (!status.user.sid) throw new Error("Official sandbox account SID is unavailable");
    return status.user.sid;
  }
  if (status.user.provisioned || status.user.credPresent || status.wfp.state === "installed") {
    throw new Error("Windows sandbox installation is incomplete; repair the official installation");
  }
  const result = await installWindowsSandboxAsync({ srtWin });
  signal.throwIfAborted();
  if (result.cancelled || !result.user.provisioned || !result.user.credPresent) {
    throw new Error("Windows sandbox installation was cancelled or could not be verified");
  }
  if (!result.user.sid) throw new Error("Official installed sandbox account SID is unavailable");
  return result.user.sid;
}

export async function runSandbox(request: SandboxRequest, broker: string, signal: AbortSignal): Promise<number> {
  if (process.platform !== "win32") throw new Error("This portable sandbox supports Windows only");
  const configured = process.env.BIT_AGENT_SANDBOX_EXECUTABLE;
  if (!configured) throw new Error("The verified Windows sandbox helper is unavailable");
  const helper = outsideWorkspace(request.workspace, configured);
  const runtimeBroker = outsideWorkspace(request.workspace, broker);
  outsideWorkspace(request.workspace, process.execPath);
  const release = await acquireSandboxLock(signal);
  try {
    return await runExclusive(request, helper, runtimeBroker, signal);
  } finally {
    await release();
  }
}

async function runExclusive(request: SandboxRequest, helper: string, runtimeBroker: string, signal: AbortSignal): Promise<number> {
  let sandboxUserSid: string | undefined;
  try {
    sandboxUserSid = await ensureInstallation(helper, signal);
    bootstrapRuntimeReads(helper, runtimeBroker, sandboxUserSid);
    const policy = sandboxPolicy(request, helper, runtimeBroker);
    await SandboxManager.initialize(policy);
    signal.throwIfAborted();
    enforceReadDenials(policy, helper, sandboxUserSid);
    const invocation = sandboxCommand(request);
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      invocation.command, invocation.shell, undefined, signal, request.workspace,
    );
    signal.throwIfAborted();
    return await runSandboxChild(wrapped.argv, wrapped.env, request.workspace, signal);
  } finally {
    // Initialization has settled before reset, including cancellation during async setup.
    await resetSandbox(helper, sandboxUserSid);
  }
}
