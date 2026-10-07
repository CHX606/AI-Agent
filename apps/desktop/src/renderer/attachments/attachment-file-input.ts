import { FILE_LIMITS, normalizeAttachments, type FileAttachment } from "../../shared/attachment-input";

function readDataUrl(file: File, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result) : reject(new Error(`无法读取附件：${file.name}`));
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取附件：${file.name}`));
    reader.onabort = () => reject(new Error(`附件读取已取消：${file.name}`));
    reader.readAsDataURL(file.type ? file : file.slice(0, file.size, mime));
  });
}

export async function readAttachmentFiles(files: readonly File[]): Promise<FileAttachment[]> {
  if (files.length > FILE_LIMITS.maxCount) throw new Error(`最多添加 ${FILE_LIMITS.maxCount} 个附件`);
  const attachments: FileAttachment[] = [];
  for (const file of files) {
    if (file.size > FILE_LIMITS.maxFileBytes) throw new Error(`单个附件不能超过 5 MiB：${file.name}`);
    const mime_type = file.type || "application/octet-stream";
    const data_url = await readDataUrl(file, mime_type);
    attachments.push({ name: file.name, mime_type, data_url });
  }
  return normalizeAttachments(attachments);
}
