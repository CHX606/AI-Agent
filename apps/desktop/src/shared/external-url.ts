/** 输出中的外链仅交给系统浏览器，不接受文件或自定义应用协议。 */
export function externalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function imageUrl(value: string): string | null {
  const url = externalUrl(value);
  return url && !url.startsWith("mailto:") ? url : null;
}
