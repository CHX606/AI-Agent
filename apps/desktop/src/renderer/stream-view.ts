/**
 * Claude Code 风格的对话流：Agent 的文字和工具调用按发生顺序排在一起。
 * 工具是一行“● 动作 目标”，下面一行“⎿ 结果”；点开看技术详情，修改文件直接显示差异。
 * 底部的状态行代替加载卡片：“✻ 思考中… 12s · Esc 暂停”。
 */
import type { TaskEvent } from "../shared/contracts";
import { object } from "./dom";
import { renderMarkdown } from "./markdown";
import { eventPresentation, isMainAgentText } from "./presentation";
import "./transcript.css";

export interface FileDiff { path: string; diff: string; truncated?: boolean }

export interface StreamViewOptions {
  stream: HTMLOListElement;
  statusLine: HTMLElement;
  scroller: HTMLElement;
  /** 取某次 apply_patch 调用写入的差异；取不到时返回空数组。 */
  loadDiff(callId: string): Promise<FileDiff[]>;
}

export interface FinishInput {
  answer: string | null;
  failure: string | null;
  cancelled: boolean;
}

const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const DIFF_PREVIEW_LINES = 14;
const RUNNING = new Set(["SUBMITTING", "QUEUED", "RUNNING", "CANCELLATION_REQUESTED", "PAUSE_REQUESTED"]);

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function createStreamView(options: StreamViewOptions) {
  const { stream, statusLine, scroller } = options;
  const glyph = statusLine.querySelector<HTMLElement>(".status-glyph")!;
  const verb = statusLine.querySelector<HTMLElement>(".status-verb")!;
  const meta = statusLine.querySelector<HTMLElement>(".status-meta")!;
  const tools = new Map<string, HTMLLIElement>();
  let text: { body: HTMLElement; raw: string } | null = null;
  let renderScheduled = false;
  let startedAt = Date.now();
  let phase = "思考中";
  let status = "IDLE";
  let frame = 0;
  let operations = 0;
  let loading: string | null = null;

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  const toBottom = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
  // 和终端一样“粘在底部”：用户停在底部时新内容自动跟随；往上翻看时不打扰。
  let stuck = true;
  scroller.addEventListener("scroll", () => { stuck = nearBottom(); }, { passive: true });
  // 下方的问答卡片、暂停面板出现时可视区域变矮，最新内容不能被挤出视野。
  new ResizeObserver(() => { if (stuck) toBottom(); }).observe(scroller);

  function append(item: HTMLElement): void {
    stream.append(item);
    if (stuck) toBottom();
  }

  function bullet(): HTMLSpanElement {
    const mark = document.createElement("span");
    mark.className = "stream-bullet";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "●";
    return mark;
  }

  function scheduleRender(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    // 流式文字按帧合并渲染：回放上千个片段时也不会每个片段都重排一次。
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!text) return;
      renderMarkdown(text.body, text.raw);
      if (stuck) toBottom();
    });
  }

  function textBlock(): { body: HTMLElement; raw: string } {
    const item = document.createElement("li");
    item.className = "stream-item stream-text";
    const body = document.createElement("div");
    body.className = "markdown-body";
    item.append(bullet(), body);
    append(item);
    return { body, raw: "" };
  }

  function appendText(delta: string): void {
    text ??= textBlock();
    text.raw += delta;
    scheduleRender();
  }

  function note(title: string, tone: string, nested: boolean): void {
    if (!title) return;
    text = null;
    const item = document.createElement("li");
    item.className = "stream-item stream-note";
    item.dataset.tone = tone;
    if (nested) item.dataset.nested = "true";
    const mark = document.createElement("span");
    mark.className = "stream-note-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "※";
    const copy = document.createElement("span");
    copy.textContent = title;
    item.append(mark, copy);
    append(item);
  }

  function renderDiff(container: HTMLElement, files: FileDiff[]): void {
    container.replaceChildren();
    let shown = 0;
    const hidden: HTMLElement[] = [];
    for (const file of files) {
      const header = document.createElement("div");
      header.className = "diff-file";
      header.textContent = file.path;
      container.append(header);
      for (const line of file.diff.split("\n")) {
        if (line.startsWith("---") || line.startsWith("+++") || !line) continue;
        const row = document.createElement("div");
        row.className = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove"
          : line.startsWith("@@") ? "diff-hunk" : "diff-context";
        row.textContent = line;
        if (shown >= DIFF_PREVIEW_LINES) { row.hidden = true; hidden.push(row); }
        shown += 1;
        container.append(row);
      }
    }
    if (hidden.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "diff-more";
      more.textContent = `… 展开其余 ${hidden.length} 行`;
      more.addEventListener("click", () => { for (const row of hidden) row.hidden = false; more.remove(); });
      container.append(more);
    }
    container.hidden = shown === 0;
  }

  function toolRow(event: TaskEvent, agent: string): void {
    const presentation = eventPresentation(event);
    if (!presentation) return;
    const data = object(event.data);
    const payload = object(data?.payload) ?? data ?? {};
    const operation = object(payload.operation);
    const external = /^mcp__/u.test(presentation.toolName ?? "");
    const label = external ? "外部工具" : typeof operation?.label === "string" ? operation.label : presentation.toolName ?? "操作";
    let item = tools.get(presentation.key);
    if (!item) {
      text = null;
      operations += 1;
      item = document.createElement("li");
      item.className = "stream-item stream-tool";
      if (agent !== "main") item.dataset.nested = "true";
      item.innerHTML = `<button class="tool-head" type="button" aria-expanded="false"></button>
        <div class="tool-result"><span class="tool-branch" aria-hidden="true">⎿</span><span class="tool-summary"></span></div>
        <div class="tool-diff" hidden></div><div class="tool-detail" hidden></div>`;
      const head = item.querySelector<HTMLButtonElement>(".tool-head")!;
      const name = document.createElement("span");
      name.className = "tool-label";
      name.textContent = label;
      const target = document.createElement("span");
      target.className = "tool-target";
      target.textContent = presentation.target ?? "";
      head.append(bullet(), name, target);
      head.addEventListener("click", () => {
        const detail = item!.querySelector<HTMLElement>(".tool-detail")!;
        detail.hidden = !detail.hidden;
        head.setAttribute("aria-expanded", String(!detail.hidden));
      });
      tools.set(presentation.key, item);
      append(item);
    }
    item.dataset.tone = presentation.tone;
    const finished = event.event_type === "TOOL_COMPLETED";
    const summary = typeof payload.summary === "string" ? payload.summary : "";
    const duration = typeof payload.duration_ms === "number" && payload.duration_ms >= 1000
      ? ` · ${(payload.duration_ms / 1000).toFixed(1)}s` : "";
    const result = finished
      ? `${presentation.tone === "neutral" ? presentation.title : summary || presentation.status || ""}${duration}`
      : "运行中…";
    item.querySelector<HTMLElement>(".tool-summary")!.textContent = result || "完成";
    const detail = item.querySelector<HTMLElement>(".tool-detail")!;
    detail.replaceChildren();
    const facts = document.createElement("dl");
    const rows: [string, string | undefined][] = [
      ["状态", presentation.status], ["工具", presentation.toolName], ["错误码", presentation.errorCode],
    ];
    for (const [term, value] of rows) {
      if (!value) continue;
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = term;
      dd.textContent = value;
      facts.append(dt, dd);
    }
    const raw = document.createElement("pre");
    raw.className = "event-payload";
    raw.textContent = JSON.stringify(event.data, null, 2);
    detail.append(facts, raw);
    // 修改文件成功后，把这次写入的差异直接显示在这一行下面。
    const callId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : "";
    if (finished && presentation.toolName === "apply_patch" && presentation.tone === "success" && callId) {
      const container = item.querySelector<HTMLElement>(".tool-diff")!;
      void options.loadDiff(callId).then((files) => { if (files.length) renderDiff(container, files); }).catch(() => {});
    }
    if (!finished) phase = agent === "main" ? `${label}…` : phase;
    else if (agent === "main") phase = "思考中";
  }

  function paintStatus(): void {
    const active = RUNNING.has(status) || loading !== null;
    const waiting = status === "PAUSED" || status === "WAITING_FOR_INPUT";
    const wasHidden = statusLine.hidden;
    statusLine.hidden = !active && !waiting;
    if (wasHidden && !statusLine.hidden && stuck) requestAnimationFrame(toBottom);
    statusLine.dataset.state = waiting ? "waiting" : "running";
    if (loading !== null) {
      glyph.textContent = GLYPHS[frame % GLYPHS.length]!;
      verb.textContent = loading;
      meta.textContent = "";
      return;
    }
    if (status === "PAUSED") { glyph.textContent = "‖"; verb.textContent = "已暂停"; meta.textContent = "可以补充要求、修改目标或继续执行"; return; }
    if (status === "WAITING_FOR_INPUT") { glyph.textContent = "?"; verb.textContent = "等待你的回答"; meta.textContent = "在下方选择或填写"; return; }
    glyph.textContent = GLYPHS[frame % GLYPHS.length]!;
    verb.textContent = status === "PAUSE_REQUESTED" ? "正在暂停…" : status === "CANCELLATION_REQUESTED" ? "正在停止…"
      : status === "QUEUED" || status === "SUBMITTING" ? "等待执行…" : `${phase.replace(/…$/u, "")}…`;
    meta.textContent = `${formatElapsed(Date.now() - startedAt)}${status === "RUNNING" ? " · Esc 暂停" : ""}`;
  }

  const timer = window.setInterval(() => {
    if (statusLine.hidden) return;
    frame += 1;
    paintStatus();
  }, 150);
  window.addEventListener("beforeunload", () => window.clearInterval(timer), { once: true });

  return {
    reset(): void {
      stream.replaceChildren();
      tools.clear();
      text = null;
      operations = 0;
      phase = "思考中";
      loading = null;
      startedAt = Date.now();
      stuck = true;
      paintStatus();
      requestAnimationFrame(toBottom);
    },
    /** 载入历史轮次后回到底部，显示最新的一轮。 */
    scrollToEnd(): void { stuck = true; requestAnimationFrame(toBottom); },
    /** 任务进行中你补充的要求，像终端里那样显示成一行“› …”。 */
    userNote(message: string): void {
      text = null;
      const item = document.createElement("li");
      item.className = "stream-item stream-user";
      const mark = document.createElement("span");
      mark.className = "turn-prompt";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "›";
      const copy = document.createElement("p");
      copy.textContent = message;
      item.append(mark, copy);
      stuck = true;
      append(item);
    },
    /** 恢复运行中的任务时用任务开始时间计时。 */
    setStartedAt(value: string | null | undefined): void {
      const parsed = value ? Date.parse(value) : NaN;
      if (Number.isFinite(parsed)) startedAt = parsed;
    },
    setLoading(message: string | null): void { loading = message; paintStatus(); },
    setStatus(value: string): void {
      status = value;
      paintStatus();
      // 问答卡片和暂停面板随状态出现，同步滚到底，不依赖下一帧的尺寸回调。
      if (stuck) toBottom();
    },
    operations: () => operations,
    handle(event: TaskEvent): void {
      const data = object(event.data);
      const payload = object(data?.payload) ?? data ?? {};
      const agent = typeof data?.agent_id === "string" ? data.agent_id : "main";
      const nested = agent !== "main";
      switch (event.event_type) {
        case "MODEL_TEXT_DELTA":
          if (isMainAgentText(data) && typeof payload.text === "string") { phase = "回答中"; appendText(payload.text); }
          return;
        case "MODEL_REQUESTED":
          phase = nested ? (agent.startsWith("acceptance-") ? "独立验收中" : "子 Agent 调查中") : "思考中";
          return;
        case "MODEL_RESPONDED":
          return;
        case "TOOL_REQUESTED":
        case "TOOL_COMPLETED":
          toolRow(event, agent);
          return;
        case "AGENT_COMPLETED":
        case "AGENT_FAILED":
          if (!nested) return;
          break;
      }
      const presentation = eventPresentation(event);
      if (presentation && !presentation.remove) note(presentation.title, presentation.tone, nested);
    },
    /** 任务结束：以服务端保存的最终回答为准，失败时追加一条错误。 */
    finish(input: FinishInput): void {
      loading = null;
      if (input.answer) {
        const last = stream.lastElementChild;
        if (!text || !last?.classList.contains("stream-text")) text = textBlock();
        text.raw = input.answer;
        // 最终回答立即渲染，不等下一帧：窗口在后台时动画帧会暂停。
        renderMarkdown(text.body, text.raw);
        if (stuck) toBottom();
      }
      if (input.cancelled) note("已停止。记录已保存，可以在同一对话继续。", "neutral", false);
      else if (input.failure) this.showError(input.failure);
      status = "IDLE";
      paintStatus();
    },
    showError(message: string): void {
      text = null;
      loading = null;
      const item = document.createElement("li");
      item.className = "stream-item stream-error";
      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = "任务未完成";
      const copy = document.createElement("p");
      copy.textContent = message;
      body.append(title, copy);
      item.append(bullet(), body);
      append(item);
      paintStatus();
    },
  };
}

export type StreamView = ReturnType<typeof createStreamView>;
