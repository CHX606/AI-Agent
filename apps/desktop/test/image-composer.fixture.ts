import { renderMessageAttachments } from "../src/renderer/attachments/message-attachments";
import type { ImageAttachment } from "../src/shared/image-input";
import { ComposerImages } from "../src/renderer/attachments/composer-images";
import { renderMessageImages } from "../src/renderer/attachments/message-images";
import { renderPreviousTurns } from "../src/renderer/previous-turns";
import { createStreamView } from "../src/renderer/stream-view";
import "../src/renderer/styles/theme.css";
import "../src/renderer/styles/base.css";
import "../src/renderer/styles/composer-layout.css";
import "../src/renderer/transcript.css";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const card = document.querySelector<HTMLElement>(".composer-card")!;
const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
let changes = 0;
const controller = new ComposerImages(card, textarea, document.querySelector<HTMLElement>(".composer-actions")!,
  { disabled: () => false, changed: () => { changes += 1; } });

async function settled(): Promise<void> {
  const deadline = Date.now() + 3000;
  while (controller.isReading() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  check(!controller.isReading(), "图片读取未完成");
}

function selected(files: File[]): void {
  const transfer = new DataTransfer();
  files.forEach(file => transfer.items.add(file));
  const input = card.querySelector<HTMLInputElement>("input[type=file]")!;
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function verifyOrdinaryAttachments(image: File, picture: ImageAttachment): Promise<void> {
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  const attachment = { name: file.name, mime_type: file.type, data_url: "data:text/plain;base64,aGVsbG8=" };
  controller.clear();
  selected([image, file]);
  await settled();
  check(controller.snapshot().length === 1 && controller.attachmentsSnapshot().length === 1, "混合上传没有保留图片和普通附件");
  check(card.querySelectorAll(".composer-image img").length === 1 && card.querySelectorAll(".composer-attachment").length === 1,
    "普通附件被当作图片，或文件卡片没有显示");
  check(card.querySelector(".composer-attachment")?.textContent?.includes("5 B"), "文件卡片没有展示大小");
  card.querySelector<HTMLButtonElement>(".attachment-remove")!.click();
  check(!controller.attachmentsSnapshot().length && controller.snapshot().length === 1, "移除普通附件影响了图片");
  controller.set([picture], [attachment, attachment, attachment, attachment]);
  selected([file]);
  await settled();
  check(card.querySelector(".composer-image-error")?.textContent?.includes("最多"), "图片和普通附件没有共用五个数量限制");
  check(controller.snapshot().length + controller.attachmentsSnapshot().length === 5, "超量上传破坏了原有草稿");
  controller.clear();
  selected([file]);
  controller.clear();
  await new Promise(resolve => setTimeout(resolve, 25));
  check(!controller.attachmentsSnapshot().length, "迟到普通附件写进了已清空的草稿");
  renderPreviousTurns({ turns: [{ task_id: "file-old", objective: "", attachments: [attachment],
    intent_updates: [{ text: "", attachments: [attachment] }] }] }, null);
  check(document.querySelectorAll("#previous-turns .attachment-card").length === 2, "文件-only历史或补充附件丢失");
  const live = createStreamView({ stream: document.createElement("ol"), scroller: document.createElement("div"),
    follow: false, loadDiff: async () => [] });
  live.userNote("", [], [attachment]);
  const cached = live.detach();
  const update = { text: "", attachments: [{ name: attachment.name, mime_type: attachment.mime_type, size: 5 }] };
  renderPreviousTurns({ turns: [{ task_id: "file-old", objective: "", attachments: [attachment], intent_updates: [update] }] }, null,
    { processes: new Map([["file-old", cached]]) });
  check(document.querySelectorAll("#previous-turns .attachment-card").length === 2, "缓存普通附件补充被显示两次");
  renderPreviousTurns({ turns: [{ task_id: "file-old", objective: "", attachments: [attachment], intent_updates: [update, update] }] }, null,
    { processes: new Map([["file-old", cached]]) });
  check(document.querySelectorAll("#previous-turns .attachment-card").length === 3, "两条相同附件消息被错误合并");
  live.dispose();
  const metadata = document.querySelector<HTMLElement>("#metadata")!;
  renderMessageAttachments(metadata, update.attachments);
  check(!metadata.querySelector("img") && metadata.textContent?.includes("notes.txt"), "普通附件元数据被渲染成伪图片");
  controller.set([picture], [attachment]);
}
async function acceptance() {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
  const dataUrl = canvas.toDataURL("image/png");
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]!), character => character.charCodeAt(0));
  const image = new File([bytes], "screen.png", { type: "image/png" });
  const plain = new DataTransfer();
  plain.setData("text/plain", "plain text");
  const plainPaste = new ClipboardEvent("paste", { clipboardData: plain, bubbles: true, cancelable: true });
  textarea.dispatchEvent(plainPaste);
  check(!plainPaste.defaultPrevented && !controller.snapshot().length, "普通文字粘贴被图片功能拦截");
  const transfer = new DataTransfer();
  transfer.items.add(image);
  transfer.setData("text/plain", "look here");
  const paste = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
  textarea.dispatchEvent(paste);
  check(paste.defaultPrevented && controller.isReading(), "图片粘贴未进入读取过程");
  await settled();
  check(controller.snapshot()[0]?.data_url === dataUrl, "图片粘贴丢失原始数据");
  check(textarea.value === "look here", "混合剪贴板丢失文字");
  const preview = card.querySelector<HTMLImageElement>(".composer-image img")!;
  await preview.decode();
  check(preview.naturalWidth === 2, "草稿缩略图未正确解码");
  card.querySelector<HTMLButtonElement>(".composer-image button")!.click();
  check(!controller.snapshot().length, "图片删除未同步草稿");
  selected([image]);
  await settled();
  check(controller.snapshot().length === 1, "选择文件未添加图片");
  controller.clear();
  selected([new File(["<svg/>"], "bad.svg", { type: "image/svg+xml" })]);
  await settled();
  check(card.querySelector<HTMLElement>(".composer-image-error")!.textContent!.includes("仅支持"), "图片校验失败没有可见提示");
  check(document.body.dataset.busy === "true", "图片校验错误改变了正在运行的任务");
  controller.clear();
  selected([image]);
  controller.clear();
  await new Promise(resolve => setTimeout(resolve, 25));
  check(!controller.snapshot().length && !card.querySelector(".composer-image"), "切换对话后迟到图片写入了新草稿");
  const attachment = { name: image.name, mime_type: "image/png" as const, data_url: dataUrl };
  renderPreviousTurns({ turns: [{ task_id: "old", objective: "", images: [attachment],
    intent_updates: [{ text: "", images: [attachment] }], final_answer: "看到了图片", status: "COMPLETED" }] }, null);
  check(document.querySelectorAll("#previous-turns img").length === 2, "历史空文字消息或引导丢失图片");
  const live = createStreamView({ stream: document.createElement("ol"), scroller: document.createElement("div"),
    follow: false, loadDiff: async () => [] });
  live.userNote("", [attachment]);
  const cached = live.detach();
  const updates = [{ text: "", images: [attachment] }, { text: "保留纯文字历史" }];
  const turn = { task_id: "old", objective: "", images: [attachment], intent_updates: updates };
  renderPreviousTurns({ turns: [turn] }, null, { processes: new Map([["old", cached]]) });
  check(document.querySelectorAll("#previous-turns img").length === 2, "续聊缓存把同一条图片补充显示了两遍");
  check(document.querySelector(".turn-update")?.textContent?.includes("保留纯文字历史"), "去重改变了纯文字历史");
  turn.intent_updates = [{ text: "", images: [attachment] }, ...updates];
  renderPreviousTurns({ turns: [turn] }, null, { processes: new Map([["old", cached]]) });
  check(document.querySelectorAll("#previous-turns img").length === 3, "两个相同图片消息被错误合并");
  live.dispose();
  const metadata = document.querySelector<HTMLElement>("#metadata")!;
  renderMessageImages(metadata, [{ name: "remote.png", mime_type: "image/png", size: 123 }]);
  check(!metadata.querySelector("img") && metadata.textContent!.includes("remote.png"), "图片元信息被错误当成可加载图片");
  await verifyOrdinaryAttachments(image, attachment);
  await Promise.all([...document.querySelectorAll<HTMLImageElement>("img")].map(image => image.decode()));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const result = { normalTextPaste: true, clipboardImage: true, mixedClipboardText: true, fileSelection: true,
    thumbnailDecoded: true, removal: true, inlineErrorPreservesTask: true, staleReadDiscarded: true,
    imageOnlyHistory: true, historicalSupplement: true, cachedLiveSupplementOnce: true,
    identicalUncachedSupplementPreserved: true, textOnlyHistoryPreserved: true,
    metadataWithoutBrokenImage: true, ordinaryFiles: true, mixedUpload: true, fileRemoval: true,
    combinedCountLimit: true, fileOnlyHistory: true, cachedFileSupplementOnce: true, fileMetadataWithoutImage: true, changes };
  return result;
}
(window as unknown as { runImageAcceptance: typeof acceptance }).runImageAcceptance = acceptance;
