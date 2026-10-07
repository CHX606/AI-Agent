import type { ImageAttachment } from "./image-input.js";

export interface FileAttachment { name: string; mime_type: string; data_url: string }
export const FILE_LIMITS = { maxCount: 5, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 } as const;
export class AttachmentInputError extends Error { readonly userFacing = true; }

export function attachmentSize(file: Pick<FileAttachment, "data_url">): number {
  const encoded = file.data_url.slice(file.data_url.indexOf(",") + 1);
  return encoded.length * 3 / 4 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
}

function normalizeAttachment(value: unknown): FileAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttachmentInputError("附件格式不正确");
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some(key => !["name", "mime_type", "data_url"].includes(key))) {
    throw new AttachmentInputError("附件包含不支持的字段");
  }
  if (typeof file.name !== "string" || !file.name.trim() || file.name.length > 255
    || /[\x00-\x1f\x7f-\x9f/\\]/u.test(file.name) || /^[A-Za-z]:/u.test(file.name.trim())
    || [".", ".."].includes(file.name.trim())) throw new AttachmentInputError("附件文件名不正确");
  if (typeof file.mime_type !== "string" || file.mime_type.length > 127
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(file.mime_type)) {
    throw new AttachmentInputError("附件类型不正确");
  }
  if (typeof file.data_url !== "string") throw new AttachmentInputError("附件数据不正确");
  const prefix = `data:${file.mime_type};base64,`;
  if (!file.data_url.startsWith(prefix)) throw new AttachmentInputError("附件类型与数据不一致");
  const encoded = file.data_url.slice(prefix.length);
  if (encoded.length > 4 * Math.ceil(FILE_LIMITS.maxFileBytes / 3)) throw new AttachmentInputError("单个附件不能超过 5 MiB");
  if (encoded && (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))) {
    throw new AttachmentInputError("附件数据不是有效的 base64");
  }
  const bytes = atob(encoded);
  if (btoa(bytes) !== encoded) throw new AttachmentInputError("附件数据不是规范的 base64");
  if (bytes.length > FILE_LIMITS.maxFileBytes) throw new AttachmentInputError("单个附件不能超过 5 MiB");
  return { name: file.name.trim(), mime_type: file.mime_type, data_url: file.data_url };
}

export function normalizeAttachments(value: unknown): FileAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > FILE_LIMITS.maxCount) throw new AttachmentInputError("每次最多添加 5 个附件");
  const files = value.map(normalizeAttachment);
  validateUploadLimits([], files);
  return files;
}

export function validateUploadLimits(images: ImageAttachment[], attachments: FileAttachment[]): void {
  if (!attachments.length) return;
  const uploads = [...images, ...attachments];
  if (uploads.length > FILE_LIMITS.maxCount) throw new AttachmentInputError("图片与附件每次合计最多 5 个");
  if (uploads.reduce((total, file) => total + attachmentSize(file), 0) > FILE_LIMITS.maxTotalBytes) {
    throw new AttachmentInputError("图片与附件总大小不能超过 20 MiB");
  }
}
