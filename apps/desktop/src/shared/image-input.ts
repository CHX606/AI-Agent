export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];
export interface ImageAttachment { name: string; mime_type: ImageMimeType; data_url: string }
export const IMAGE_LIMITS = {
  maxCount: 5,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxRequestBytes: 28 * 1024 * 1024,
} as const;

export class ImageInputError extends Error { readonly userFacing = true; }

function signatureMatches(bytes: string, mime: ImageMimeType): boolean {
  if (mime === "image/png") return bytes.startsWith("\x89PNG\r\n\x1a\n");
  if (mime === "image/jpeg") return bytes.startsWith("\xff\xd8\xff");
  if (mime === "image/webp") return bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
  return bytes.startsWith("GIF87a") || bytes.startsWith("GIF89a");
}

function decodedImageSize(image: ImageAttachment): number {
  const prefix = `data:${image.mime_type};base64,`;
  if (!image.data_url.startsWith(prefix)) throw new ImageInputError("图片类型与数据不一致");
  const encoded = image.data_url.slice(prefix.length);
  if (encoded.length > 4 * Math.ceil(IMAGE_LIMITS.maxImageBytes / 3)) throw new ImageInputError("单张图片不能超过 5 MiB");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new ImageInputError("图片数据不是有效的 base64");
  }
  const bytes = atob(encoded);
  if (btoa(bytes) !== encoded) throw new ImageInputError("图片数据不是规范的 base64");
  if (bytes.length > IMAGE_LIMITS.maxImageBytes) throw new ImageInputError("单张图片不能超过 5 MiB");
  if (!signatureMatches(bytes, image.mime_type)) throw new ImageInputError("图片内容与文件类型不一致");
  return bytes.length;
}

function normalizeImage(value: unknown): ImageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ImageInputError("图片附件格式不正确");
  const image = value as Record<string, unknown>;
  if (Object.keys(image).some(key => !["name", "mime_type", "data_url"].includes(key))) {
    throw new ImageInputError("图片附件包含不支持的字段");
  }
  if (typeof image.name !== "string" || !image.name.trim() || image.name.length > 255
    || /[\x00-\x1f\x7f-\x9f/\\]/u.test(image.name) || /^[A-Za-z]:/u.test(image.name.trim())
    || [".", ".."].includes(image.name.trim())) {
    throw new ImageInputError("图片文件名不正确");
  }
  if (!IMAGE_MIME_TYPES.includes(image.mime_type as ImageMimeType)) throw new ImageInputError("只支持 PNG、JPEG、WebP 和非动画 GIF 图片");
  if (typeof image.data_url !== "string") throw new ImageInputError("图片数据不正确");
  return { name: image.name.trim(), mime_type: image.mime_type as ImageMimeType, data_url: image.data_url };
}

export function normalizeImages(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > IMAGE_LIMITS.maxCount) throw new ImageInputError("每次最多发送 5 张图片");
  const images = value.map(normalizeImage);
  const total = images.reduce((size, image) => size + decodedImageSize(image), 0);
  if (total > IMAGE_LIMITS.maxTotalBytes) throw new ImageInputError("每次图片总大小不能超过 20 MiB");
  return images;
}
