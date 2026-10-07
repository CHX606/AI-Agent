import { expect, it } from "vitest";
import { attachmentSize, normalizeAttachments, validateUploadLimits } from "../src/shared/attachment-input";
import type { ImageAttachment } from "../src/shared/image-input";

const file = { name: "中文.txt", mime_type: "text/plain", data_url: "data:text/plain;base64,5Lit5paH" };

it("preserves filenames and canonical bytes, including valid empty text files", () => {
  expect(normalizeAttachments([file])).toEqual([file]);
  expect(attachmentSize(file)).toBe(6);
  expect(normalizeAttachments([{ ...file, data_url:"data:text/plain;base64," }])).toHaveLength(1);
  expect(normalizeAttachments(undefined)).toEqual([]);
});

it.each(["../secret.txt", "C:secret.txt", "..", "evil\n.txt"])("rejects path-like filename %s", name => {
  expect(() => normalizeAttachments([{ ...file, name }])).toThrow();
});

it("rejects noncanonical bytes, mismatched MIME and unsupported fields", () => {
  expect(() => normalizeAttachments([{ ...file, data_url:"data:text/plain;base64,YR==" }])).toThrow("规范");
  expect(() => normalizeAttachments([{ ...file, mime_type:"application/pdf" }])).toThrow("不一致");
  expect(() => normalizeAttachments([{ ...file, path:"C:/secret" }])).toThrow("字段");
  expect(() => normalizeAttachments(null)).toThrow();
});

it("counts images and documents together before sending", () => {
  const image = { ...file, mime_type:"image/png" } as ImageAttachment;
  expect(() => validateUploadLimits(Array(5).fill(image),[file])).toThrow("合计最多");
  const large = { ...file, data_url:`data:text/plain;base64,${"AAAA".repeat(Math.floor(5 * 1024 * 1024 / 3))}` };
  expect(() => validateUploadLimits(Array(3).fill(large as ImageAttachment),[large,large])).toThrow("总大小");
});
