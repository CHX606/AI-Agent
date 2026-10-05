import { SandboxManager, resolveSrtWin, revokeWindowsAcl, restoreWindowsAcl } from "@anthropic-ai/sandbox-runtime";

const released = new Set(["revoked", "stillHeld", "restored", "alreadyOriginal"]);

/** Inspect the official release results before reset's best-effort cleanup discards them. */
export async function resetSandbox(helper: string, sandboxUserSid?: string): Promise<void> {
  try {
    if (!sandboxUserSid) return;
    const options = { sandboxUserSid, srtWin: resolveSrtWin({ path: helper }) };
    const grants = revokeWindowsAcl(options);
    const denies = restoreWindowsAcl(options);
    if (!grants || !denies) throw new Error("official ACL cleanup helper did not return verifiable results");
    const failed = [...grants, ...denies].filter(result => !released.has(result.status));
    if (failed.length) {
      throw new Error("official ACL cleanup failed: " + failed.map(result => result.path + " " + result.status).join("; "));
    }
  } catch (error) {
    throw new Error("BIT_AGENT_SANDBOX_CLEANUP_ERROR: " + String(error));
  } finally {
    await SandboxManager.reset();
  }
}
