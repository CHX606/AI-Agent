import { shell, type WebContents } from "electron";
import type { DiagnosticService } from "@bit-agent/diagnostics";
import { externalUrl } from "../../shared/external-url.js";

export function sameDesktopPage(current: string, target: string): boolean {
  try {
    const source = new URL(current);
    const destination = new URL(target);
    if (source.protocol !== "file:" || destination.protocol !== "file:") return false;
    source.hash = "";
    destination.hash = "";
    return source.href === destination.href;
  } catch {
    return false;
  }
}

export function configureExternalNavigation(contents: WebContents, diagnostics: DiagnosticService): void {
  const open = (value: string): void => {
    const url = externalUrl(value);
    if (!url) return;
    void shell.openExternal(url).catch(error => {
      diagnostics.failure("external_link_failed", error, {});
    });
  };
  contents.setWindowOpenHandler(({ url }) => { open(url); return { action: "deny" }; });
  contents.on("will-navigate", (event, url) => {
    if (sameDesktopPage(contents.getURL(), url)) return;
    event.preventDefault();
    open(url);
  });
}
