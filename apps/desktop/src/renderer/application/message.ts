import type { ComposerMessage, RendererApp } from "./context";
export type { ComposerMessage } from "./context";

export function composerMessage(app: RendererApp): ComposerMessage {
  const attachments = app.composerImages?.attachmentsSnapshot?.() ?? [];
  return { text: app.objectiveInput.value.trim(), images: app.composerImages?.snapshot() ?? [],
    ...(attachments.length ? { attachments } : {}) };
}

export function messageHasContent(message: ComposerMessage): boolean {
  return Boolean(message.text || message.images.length || message.attachments?.length);
}

export function hasComposerContent(app: RendererApp): boolean { return messageHasContent(composerMessage(app)); }

export function messageTitle(message: ComposerMessage): string {
  return message.text || message.images[0]?.name || message.attachments?.[0]?.name || "新任务";
}

export function clearComposerMessage(app: RendererApp): void {
  app.objectiveInput.value = "";
  app.composerImages?.clear();
}

export function restoreComposerMessage(app: RendererApp, message: ComposerMessage): void {
  app.objectiveInput.value = message.text;
  app.composerImages?.set(message.images, message.attachments ?? []);
}
