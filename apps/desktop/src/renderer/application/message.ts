import type { ComposerMessage, RendererApp } from "./context";
export type { ComposerMessage } from "./context";

export function composerMessage(app: RendererApp): ComposerMessage {
  return { text: app.objectiveInput.value.trim(), images: app.composerImages?.snapshot() ?? [] };
}

export function hasComposerContent(app: RendererApp): boolean {
  return Boolean(app.objectiveInput.value.trim() || app.composerImages?.snapshot().length);
}

export function messageTitle(message: ComposerMessage): string {
  return message.text || message.images[0]?.name || "新任务";
}

export function clearComposerMessage(app: RendererApp): void {
  app.objectiveInput.value = "";
  app.composerImages?.clear();
}

export function restoreComposerMessage(app: RendererApp, message: ComposerMessage): void {
  app.objectiveInput.value = message.text;
  app.composerImages?.set(message.images);
}
