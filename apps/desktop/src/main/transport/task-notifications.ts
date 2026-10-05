import { BrowserWindow, Notification } from "electron";
import type { TaskEvent } from "../../shared/contracts.js";
import { attentionNotice } from "../application/notifications.js";

/** 窗口不在前台时，任务结束或等待回答用系统通知加任务栏闪烁提醒。 */
export function createTaskAnnouncer(): (sender: Electron.WebContents, event: TaskEvent) => void {
  const announced = new Set<string>();
  return (sender, event) => {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || window.isDestroyed() || window.isFocused()) return;
    const notice = attentionNotice(event);
    if (!notice || announced.has(notice.key)) return;
    announced.add(notice.key);
    window.flashFrame(true);
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: notice.title, body: notice.body });
    notification.on("click", () => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  };
}
