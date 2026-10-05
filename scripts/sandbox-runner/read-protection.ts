import { expandWindowsFsPaths, resolveSrtWin, stampWindowsAcl } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export function enforceReadDenials(policy: SandboxRuntimeConfig, helper: string, sandboxUserSid: string): void {
  const denyRead = expandWindowsFsPaths(policy.filesystem.denyRead, { mode: "deny" });
  if (!denyRead.length) return;
  // The SDK's last WriteDeny for one holder can replace its ReadDeny; reassert FILE_ALL before execution.
  stampWindowsAcl({ sandboxUserSid, srtWin: resolveSrtWin({ path: helper }), denyRead, denyWrite: [] });
}
