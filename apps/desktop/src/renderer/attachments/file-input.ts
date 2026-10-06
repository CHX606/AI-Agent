import { IMAGE_LIMITS, IMAGE_MIME_TYPES, normalizeImages, type ImageAttachment } from "../../shared/image-input";

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result) : reject(new Error(`无法读取图片：${file.name}`));
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取图片：${file.name}`));
    reader.onabort = () => reject(new Error(`图片读取已取消：${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function readImageFiles(files: readonly File[]): Promise<ImageAttachment[]> {
  if (files.length > IMAGE_LIMITS.maxCount) throw new Error(`最多添加 ${IMAGE_LIMITS.maxCount} 张图片`);
  const images: ImageAttachment[] = [];
  for (const file of files) {
    if (!IMAGE_MIME_TYPES.includes(file.type as ImageAttachment["mime_type"])) {
      throw new Error("仅支持 PNG、JPEG、WebP 和非动画 GIF 图片");
    }
    if (file.size > IMAGE_LIMITS.maxImageBytes) throw new Error(`单张图片不能超过 5 MiB：${file.name}`);
    const data_url = await readDataUrl(file);
    images.push({ name: file.name || "截图.png", mime_type: file.type as ImageAttachment["mime_type"], data_url });
  }
  return normalizeImages(images);
}

export function pastedImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.items].filter(item => item.kind === "file" && item.type.startsWith("image/"))
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
}
