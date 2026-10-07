import type { RendererApp } from "./context";
import { clearComposerMessage, composerMessage, messageHasContent } from "./message";

function renderQueue(app: RendererApp): void {
  app.queuedList.replaceChildren(...app.queued.map((message, index) => {
    const item = document.createElement("li");
    item.className = "queued-message";
    const label = document.createElement("span");
    label.className = "queued-label";
    label.textContent = index === 0 ? "下一条" : "排队";
    const copy = document.createElement("span");
    copy.className = "queued-text";
    const count = message.images.length + (message.attachments?.length ?? 0);
    const text = message.text + (count ? `${message.text ? " · " : ""}${count} 个附件` : "");
    copy.textContent = text;
    copy.title = [message.text, ...message.images.map(image => image.name), ...(message.attachments ?? []).map(file => file.name)].filter(Boolean).join("\n");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "queued-remove";
    remove.setAttribute("aria-label", `移除排队的消息：${text}`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
    remove.addEventListener("click", () => { app.queued.splice(index, 1); app.renderQueue(); });
    item.append(label, copy, remove);
    return item;
  }));
  app.queuedList.hidden = app.queued.length === 0;
}

function enqueue(app: RendererApp): void {
  const message = composerMessage(app);
  if (!messageHasContent(message) || app.composerImages?.isReading()) return;
  app.queued.push(message);
  clearComposerMessage(app);
  app.renderQueue();
  app.paintComposer();
}

function sendQueued(app: RendererApp, status: string): void {
  if (!app.queued.length || status === "CANCELLED" || app.submitting || document.body.dataset.busy === "true") return;
  const message = app.queued.shift()!;
  app.renderQueue();
  if (message.attachments?.length) void app.runAgent(message.text, message.images, message.attachments);
  else void app.runAgent(message.text, message.images);
}

function clearQueue(app: RendererApp): void {
  app.queued.length = 0;
  app.renderQueue();
}

export function createQueueController(app: RendererApp) {
  return {
    renderQueue: renderQueue.bind(null, app),
    enqueue: enqueue.bind(null, app),
    sendQueued: sendQueued.bind(null, app),
    clearQueue: clearQueue.bind(null, app),
  };
}
