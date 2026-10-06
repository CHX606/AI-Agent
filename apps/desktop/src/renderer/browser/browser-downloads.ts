/** 浏览器底部的下载栏：进度、打开、在文件夹中显示、取消；完成的条目可以关掉。 */
import type { BrowserDownload } from "../../shared/contracts.js";
import { closeIcon } from "./browser-markup.js";

const MAX_ITEMS = 4;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function downloadStatus(download: BrowserDownload): string {
  if (download.state === "completed") return `已完成 · ${formatBytes(download.received)}`;
  if (download.state === "cancelled") return "已取消";
  if (download.state === "interrupted") return "下载中断";
  if (!download.total) return `正在下载 · ${formatBytes(download.received)}`;
  return `正在下载 · ${formatBytes(download.received)} / ${formatBytes(download.total)}`;
}

export function mountDownloads(container: HTMLElement): void {
  const items = new Map<string, HTMLElement>();
  const refresh = () => { container.hidden = items.size === 0; };

  window.bitAgent.onBrowserDownload((download) => {
    let element = items.get(download.id);
    if (!element) {
      element = document.createElement("div");
      element.className = "browser-download";
      element.innerHTML = `<div class="browser-download-copy"><strong></strong><span></span></div>
        <progress max="1" value="0"></progress>
        <div class="browser-download-actions">
          <button type="button" class="browser-link" data-download="open">打开</button>
          <button type="button" class="browser-link" data-download="show">在文件夹中显示</button>
          <button type="button" class="browser-link" data-download="cancel">取消</button>
          <button type="button" class="icon-button" data-download="dismiss" aria-label="移除这条记录" title="移除这条记录">${closeIcon}</button>
        </div>`;
      for (const button of element.querySelectorAll<HTMLButtonElement>("[data-download]")) {
        button.addEventListener("click", () => {
          const action = button.dataset.download!;
          if (action === "dismiss") { element!.remove(); items.delete(download.id); refresh(); return; }
          void window.bitAgent.downloadAction(download.id, action as "open" | "show" | "cancel").catch((error: unknown) => {
            element!.querySelector("span")!.textContent = error instanceof Error ? error.message : String(error);
          });
        });
      }
      items.set(download.id, element);
      container.prepend(element);
      while (items.size > MAX_ITEMS) {
        const [oldest, node] = [...items.entries()].at(-1)!;
        node.remove();
        items.delete(oldest);
      }
    }
    element.dataset.state = download.state;
    element.querySelector("strong")!.textContent = download.filename;
    element.querySelector("strong")!.title = download.path;
    element.querySelector("span")!.textContent = downloadStatus(download);
    const progress = element.querySelector("progress")!;
    progress.hidden = download.state !== "progressing";
    if (download.total) progress.value = download.received / download.total;
    else progress.removeAttribute("value");
    const done = download.state === "completed";
    element.querySelector<HTMLButtonElement>("[data-download=open]")!.hidden = !done || download.executable;
    element.querySelector<HTMLButtonElement>("[data-download=show]")!.hidden = !done;
    element.querySelector<HTMLButtonElement>("[data-download=cancel]")!.hidden = download.state !== "progressing";
    element.querySelector<HTMLButtonElement>("[data-download=dismiss]")!.hidden = download.state === "progressing";
    refresh();
  });
}
