/** 最后一条消息下面的“编辑”和“重新生成”：先回到这一轮开始前，再改写或原样重发。 */
import { normalizeImages, type ImageAttachment } from "../../shared/image-input";
import { replyMarkdown } from "../copy-button";
import { element, errorText } from "../dom";
import { iconButton, replyActions, userActions } from "../message-actions";
import { saveHistory } from "../task-history";
import type { RendererApp } from "./context";

const EDIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>';
const REGENERATE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>';

interface Rewound { objective: string; images: ImageAttachment[]; workspaceRoot: string; sessionDeleted: boolean }

function available(app: RendererApp): boolean {
  const status = app.statusText.dataset.status ?? "";
  return Boolean(app.activeTaskId && app.activeSessionId && app.rewindableTaskId === app.activeTaskId)
    && app.terminalStatuses.has(status) && document.body.dataset.busy !== "true" && !app.submitting && !app.replaying;
}

async function rewind(app: RendererApp): Promise<Rewound | null> {
  const message = "这会删除最后一轮的回答，并撤销这一轮对文件的改动（如果有），然后回到发送这条消息之前。继续？";
  if (!app.activeTaskId || !app.activeSessionId || !window.confirm(message)) return null;
  const sessionId = app.activeSessionId;
  app.submitting = true;
  app.setBusy(true);
  let result: Record<string, unknown>;
  try {
    result = await window.bitAgent.rewindTurn({ gatewayUrl: app.gatewayUrl, sessionId, taskId: app.activeTaskId });
  } catch (error) {
    // 失败时什么都没改，对话保持原样；不能用 showError 把这一轮标成出错。
    window.alert(`没有修改这一轮：${errorText(error)}`);
    return null;
  } finally {
    app.submitting = false;
    app.setBusy(false);
  }
  return {
    objective: typeof result.objective === "string" ? result.objective : "",
    images: savedImages(result.images), workspaceRoot: String(result.workspace_root ?? app.activeWorkspaceRoot),
    sessionDeleted: result.session_deleted === true,
  };
}

function savedImages(value: unknown): ImageAttachment[] {
  try { return Array.isArray(value) ? normalizeImages(value) : []; }
  catch { return []; }
}

/** 唯一的一轮被收回时服务端已删除对话；本地侧栏记录也要去掉，再开一个同目录的新对话。 */
function startOver(app: RendererApp, sessionId: string, workspaceRoot: string): void {
  app.history = app.history.filter(item => !(item.sessionId === sessionId && item.gatewayUrl === app.gatewayUrl));
  saveHistory(app.history);
  app.resetTask();
  app.newConversationIn(workspaceRoot);
}

/** 显示回到这一轮之前的对话：还有更早的轮次就打开它。 */
async function showRewound(app: RendererApp, sessionId: string, rewound: Rewound): Promise<void> {
  if (rewound.sessionDeleted) { startOver(app, sessionId, rewound.workspaceRoot); return; }
  await app.refreshSessions();
  const entry = app.history.find(item => item.sessionId === sessionId && item.gatewayUrl === app.gatewayUrl);
  if (entry) await app.restoreTask(entry);
  else startOver(app, sessionId, rewound.workspaceRoot);
}

/** 重新生成不回放上一轮（回放期间页面忙，发不出去）；提交新一轮时会自己显示更早的轮次。 */
async function resend(app: RendererApp, sessionId: string, rewound: Rewound): Promise<void> {
  if (app.activeTaskId) window.bitAgent.unwatchTask(app.activeTaskId);
  app.activeTaskId = null;
  if (rewound.sessionDeleted) startOver(app, sessionId, rewound.workspaceRoot);
  await app.runAgent(rewound.objective, rewound.images);
}

async function editOrRegenerate(app: RendererApp, regenerate: boolean): Promise<void> {
  const sessionId = app.activeSessionId;
  const rewound = await rewind(app);
  if (!rewound || !sessionId) return;
  if (regenerate) { await resend(app, sessionId, rewound); return; }
  await showRewound(app, sessionId, rewound);
  app.objectiveInput.value = rewound.objective;
  app.composerImages?.set(rewound.images);
  app.paintComposer();
  app.objectiveInput.focus();
}

/** 当前这一轮：用户消息下面“复制 / 编辑 / 重新生成”，回答下面“复制”。 */
export function mountTurnActions(app: RendererApp): () => void {
  const edit = iconButton("编辑", EDIT_ICON, () => void editOrRegenerate(app, false));
  const regenerate = iconButton("重新生成", REGENERATE_ICON, () => void editOrRegenerate(app, true));
  const user = userActions(() => app.activeObjective, [edit, regenerate]);
  const stream = element<HTMLOListElement>("#stream");
  const reply = replyActions(stream);
  app.objectiveDisplay.closest(".turn-user")?.after(user);
  stream.after(reply);
  return () => {
    const rewindable = available(app);
    edit.hidden = !rewindable;
    regenerate.hidden = !rewindable;
    user.hidden = !app.activeObjective.trim();
    // 运行中回答还在变，结束后再给复制。
    reply.hidden = document.body.dataset.busy === "true" || app.replaying || !replyMarkdown(stream);
  };
}
