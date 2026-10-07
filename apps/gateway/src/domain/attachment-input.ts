import { z } from "zod";
import type { ImageAttachment } from "./image-input.js";

export interface FileAttachment { name:string; mime_type:string; data_url:string }
export const FILE_LIMITS = {
  maxCount:5,
  maxFileBytes:5 * 1024 * 1024,
  maxTotalBytes:20 * 1024 * 1024,
} as const;

function fileSize(file: FileAttachment): number | null {
  const prefix = `data:${file.mime_type};base64,`;
  if (!file.data_url.startsWith(prefix)) return null;
  const encoded = file.data_url.slice(prefix.length);
  if (encoded.length > 4 * Math.ceil(FILE_LIMITS.maxFileBytes / 3) || encoded.length % 4 !== 0
    || (encoded && !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > FILE_LIMITS.maxFileBytes || bytes.toString("base64") !== encoded) return null;
  return bytes.length;
}

const attachmentSchema = z.object({
  name:z.string().min(1).max(255).refine(name => Boolean(name.trim()) && !/[\x00-\x1f\x7f-\x9f/\\]/u.test(name)
    && !/^[A-Za-z]:/u.test(name.trim()) && ![".", ".."].includes(name.trim()), "附件文件名不正确").transform(name => name.trim()),
  mime_type:z.string().max(127).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu, "附件 MIME 类型不正确"),
  data_url:z.string().max(4 * Math.ceil(FILE_LIMITS.maxFileBytes / 3) + 160),
}).strict().refine(file => fileSize(file) !== null, "附件数据、类型或大小不正确（单个最多 5 MiB）");

export const attachmentsSchema = z.array(attachmentSchema).max(FILE_LIMITS.maxCount)
  .refine(files => files.reduce((total, file) => total + (fileSize(file) ?? 0), 0)
    <= FILE_LIMITS.maxTotalBytes, "每次附件总大小不能超过 20 MiB");

export function uploadsWithinLimits(input: { images?:ImageAttachment[] | undefined; attachments?:FileAttachment[] | undefined }): boolean {
  const files = [...(input.images ?? []), ...(input.attachments ?? [])];
  return files.length <= FILE_LIMITS.maxCount && files.reduce((total, file) => total
    + Buffer.from(file.data_url.split(",", 2)[1] ?? "", "base64").length, 0) <= FILE_LIMITS.maxTotalBytes;
}
