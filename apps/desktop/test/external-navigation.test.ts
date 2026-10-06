import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { DiagnosticService } from "@bit-agent/diagnostics";
import { externalUrl, imageUrl } from "../src/shared/external-url";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => undefined) }));
vi.mock("electron", () => ({ shell: { openExternal } }));
import { configureExternalNavigation, sameDesktopPage } from "../src/main/transport/external-navigation";

function harness() {
  const handlers = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
  const contents = { getURL: vi.fn(() => "file:///D:/app/renderer/index.html"),
    setWindowOpenHandler: vi.fn(), on: vi.fn((name, handler) => handlers.set(name, handler)) };
  const diagnostics = { failure: vi.fn() };
  configureExternalNavigation(contents as unknown as WebContents, diagnostics as unknown as DiagnosticService);
  return { contents, diagnostics, handlers };
}
afterEach(() => vi.clearAllMocks());

describe("output link navigation policy", () => {
  it.each(["https://example.com/docs", "http://127.0.0.1:8080/", "mailto:demo@example.com"])("accepts %s", value => {
    expect(externalUrl(value)).toBe(value);
  });

  it.each(["javascript:alert(1)", "file:///C:/Windows", "data:text/html,test", "bit-agent:test", "ms-settings:",
    "httpsx://example.com", "//example.com", "../README.md", "C:/project/readme.md", "#heading", ""])("rejects %s", value => {
    expect(externalUrl(value)).toBeNull();
  });

  it("images only accept web URLs", () => {
    expect(imageUrl("https://example.com/image.png")).toBe("https://example.com/image.png");
    expect(imageUrl("mailto:demo@example.com")).toBeNull();
    expect(imageUrl("data:image/svg+xml,<svg/>")).toBeNull();
  });

  it("denies every child window and opens allowed links in the system browser", async () => {
    const { contents } = harness();
    const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as (details: { url: string }) => { action: string };
    expect(handler({ url: "https://example.com/" })).toEqual({ action: "deny" });
    expect(handler({ url: "file:///C:/private.txt" })).toEqual({ action: "deny" });
    expect(handler({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/");
    await Promise.resolve();
  });

  it("prevents direct main-window navigation, including local file paths", () => {
    const { handlers } = harness();
    const event = { preventDefault: vi.fn() };
    handlers.get("will-navigate")!(event, "file:///D:/private.html");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    handlers.get("will-navigate")!(event, "mailto:demo@example.com");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("mailto:demo@example.com");
  });

  it("allows the current desktop page to reload or jump to a fragment without opening a browser", () => {
    const { handlers } = harness();
    for (const url of ["file:///D:/app/renderer/index.html", "file:///D:/app/renderer/index.html#section"]) {
      const event = { preventDefault: vi.fn() };
      handlers.get("will-navigate")!(event, url);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each(["file:///D:/app/renderer/index.html?different=1", "file:///D:/app/renderer/other.html",
    "https://example.com/index.html", "javascript:alert(1)", "", "../index.html"])("rejects changing the desktop page to %s", target => {
    expect(sameDesktopPage("file:///D:/app/renderer/index.html#old", target)).toBe(false);
  });

  it("never treats an already remote URL or an empty startup URL as a trusted desktop page", () => {
    expect(sameDesktopPage("https://example.com/", "https://example.com/#section")).toBe(false);
    expect(sameDesktopPage("", "file:///D:/app/renderer/index.html")).toBe(false);
  });

  it("records system-browser failures without opening an Electron page", async () => {
    const error = new Error("系统浏览器未安装");
    openExternal.mockRejectedValueOnce(error);
    const { handlers, diagnostics } = harness();
    handlers.get("will-navigate")!({ preventDefault: vi.fn() }, "https://example.com/");
    await Promise.resolve();
    expect(diagnostics.failure).toHaveBeenCalledWith("external_link_failed", error, {});
  });
});
