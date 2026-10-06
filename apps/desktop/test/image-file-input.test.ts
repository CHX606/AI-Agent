import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_LIMITS } from "../src/shared/image-input";
import { pastedImageFiles, readImageFiles } from "../src/renderer/attachments/file-input";

const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2FIAAAAASUVORK5CYII=";
class Reader {
  result: string | null = dataUrl;
  error: Error | null = null;
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  readAsDataURL(): void { queueMicrotask(() => this.onload?.()); }
}
afterEach(() => vi.unstubAllGlobals());

describe("image selection and clipboard files", () => {
  it("reads image bytes as the shared image contract", async () => {
    vi.stubGlobal("FileReader", Reader);
    const image = new File([new Uint8Array([1])], "screen.png", { type: "image/png" });
    expect(await readImageFiles([image])).toEqual([{ name: "screen.png", mime_type: "image/png", data_url: dataUrl }]);
  });

  it("leaves normal text clipboard data alone and picks only image files", () => {
    const image = new File(["png"], "screen.png", { type: "image/png" });
    const items = [{ kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "text/plain", getAsFile: () => new File(["text"], "notes.txt") },
      { kind: "file", type: "image/png", getAsFile: () => image }];
    expect(pastedImageFiles(null)).toEqual([]);
    expect(pastedImageFiles({ items: items.slice(0, 1) } as unknown as DataTransfer)).toEqual([]);
    expect(pastedImageFiles({ items } as unknown as DataTransfer)).toEqual([image]);
  });

  it("rejects unsupported, oversized and excessive files before allocating base64 data", async () => {
    const read = vi.fn();
    vi.stubGlobal("FileReader", class extends Reader { override readAsDataURL = read; });
    await expect(readImageFiles([new File(["<svg>"], "unsafe.svg", { type: "image/svg+xml" })])).rejects.toThrow("仅支持");
    await expect(readImageFiles([{ type: "image/png", size: IMAGE_LIMITS.maxImageBytes + 1, name: "large.png" } as File]))
      .rejects.toThrow("不能超过");
    await expect(readImageFiles(Array.from({ length: 6 }, () => new File([], "x.png", { type: "image/png" }))))
      .rejects.toThrow("最多");
    expect(read).not.toHaveBeenCalled();
  });

  it("reports reader failures instead of silently dropping an attachment", async () => {
    vi.stubGlobal("FileReader", class extends Reader {
      override error = new Error("reading failed");
      override readAsDataURL(): void { queueMicrotask(() => this.onerror?.()); }
    });
    await expect(readImageFiles([new File(["png"], "screen.png", { type: "image/png" })])).rejects.toThrow("reading failed");
  });
});
