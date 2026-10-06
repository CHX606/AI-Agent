import { z } from "zod";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];
export interface ImageAttachment { name: string; mime_type: ImageMimeType; data_url: string }
export const IMAGE_LIMITS = {
  maxCount: 5,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxRequestBytes: 28 * 1024 * 1024,
} as const;

function signatureMatches(bytes: Buffer, mime: ImageMimeType): boolean {
  const prefix = bytes.subarray(0, 12).toString("latin1");
  if (mime === "image/png") return prefix.startsWith("\x89PNG\r\n\x1a\n");
  if (mime === "image/jpeg") return prefix.startsWith("\xff\xd8\xff");
  if (mime === "image/webp") return prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
  return prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a");
}

function imageSize(image: ImageAttachment): number | null {
  const prefix = `data:${image.mime_type};base64,`;
  if (!image.data_url.startsWith(prefix)) return null;
  const encoded = image.data_url.slice(prefix.length);
  if (!encoded || encoded.length > 4 * Math.ceil(IMAGE_LIMITS.maxImageBytes / 3)
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > IMAGE_LIMITS.maxImageBytes || bytes.toString("base64") !== encoded
    || !signatureMatches(bytes, image.mime_type)) return null;
  return bytes.length;
}

const imageSchema = z.object({
  name: z.string().min(1).max(255).refine(name => Boolean(name.trim()) && !/[\x00-\x1f\x7f-\x9f/\\]/u.test(name)
    && !/^[A-Za-z]:/u.test(name.trim())
    && ![".", ".."].includes(name.trim()), "图片文件名不正确").transform(name => name.trim()),
  mime_type: z.enum(IMAGE_MIME_TYPES),
  data_url: z.string().max(4 * Math.ceil(IMAGE_LIMITS.maxImageBytes / 3) + 64),
}).strict().refine(image => imageSize(image) !== null, "图片数据、类型或大小不正确（单张最多 5 MiB）");

export const imagesSchema = z.array(imageSchema).max(IMAGE_LIMITS.maxCount)
  .refine(images => images.reduce((total, image) => total + (imageSize(image) ?? 0), 0)
    <= IMAGE_LIMITS.maxTotalBytes, "每次图片总大小不能超过 20 MiB");
