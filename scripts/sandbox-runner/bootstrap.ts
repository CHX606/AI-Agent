import { win32 as path } from "node:path";
import { grantWindowsAcl, resolveSrtWin } from "@anthropic-ai/sandbox-runtime";

/** The official preflight starts the helper as srt-sandbox before initialize grants project paths. */
export function bootstrapRuntimeReads(helper: string, broker: string, sandboxUserSid: string): void {
  grantWindowsAcl({
    sandboxUserSid, srtWin: resolveSrtWin({ path: helper }),
    read: [...new Set([path.dirname(helper), path.dirname(broker), path.dirname(process.execPath)])],
    write: [],
  });
}
