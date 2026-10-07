import { afterEach, expect, it, vi } from "vitest";
import { FILE_LIMITS } from "../src/shared/attachment-input";
import { readAttachmentFiles } from "../src/renderer/attachments/attachment-file-input";

class Reader {
  result: string | null = null;
  error: Error | null = null;
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...bytes))}`;
      this.onload?.();
    });
  }
}

afterEach(() => vi.unstubAllGlobals());

it("reads ordinary file bytes and preserves the declared type", async () => {
  vi.stubGlobal("FileReader", Reader);
  expect(await readAttachmentFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]))
    .toEqual([{ name: "notes.txt", mime_type: "text/plain", data_url: "data:text/plain;base64,aGVsbG8=" }]);
});

it("uses matching application/octet-stream metadata and data URL when the OS provides no MIME", async () => {
  vi.stubGlobal("FileReader", Reader);
  expect(await readAttachmentFiles([new File(["{}"], "settings.json")]))
    .toEqual([{ name: "settings.json", mime_type: "application/octet-stream", data_url: "data:application/octet-stream;base64,e30=" }]);
});

it("rejects excessive or oversized files before allocating base64 data", async () => {
  const read = vi.fn();
  vi.stubGlobal("FileReader", class extends Reader { override readAsDataURL = read; });
  await expect(readAttachmentFiles(Array.from({ length: 6 }, () => new File([], "x.txt")))).rejects.toThrow("最多");
  await expect(readAttachmentFiles([{ size: FILE_LIMITS.maxFileBytes + 1, name: "large.pdf", type: "application/pdf" } as File]))
    .rejects.toThrow("不能超过");
  expect(read).not.toHaveBeenCalled();
});

it("reports reader errors without replacing them with an empty attachment", async () => {
  vi.stubGlobal("FileReader", class extends Reader {
    override error = new Error("disk read failed");
    override readAsDataURL(): void { queueMicrotask(() => this.onerror?.()); }
  });
  await expect(readAttachmentFiles([new File(["hello"], "notes.txt")])).rejects.toThrow("disk read failed");
});
