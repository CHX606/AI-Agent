import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskEvent } from "../src/shared/contracts";
import { createStreamView, type StreamView } from "../src/renderer/stream-view";

const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../src/renderer/markdown", () => ({ renderMarkdown: mocks.render }));
vi.mock("../src/renderer/stream/status-line", () => ({
  StreamStatusLine: class {
    stopped = false;
    setStatus(value: string): void { this.stopped = /PAUSE|CANCEL/u.test(value); }
    setPhase(): void {}
    setLoading(): void {}
    setStartedAt(): void {}
    reset(): void { this.stopped = false; }
    resume(): boolean { return false; }
    paint(): void {}
    dispose(): void {}
  },
}));
vi.mock("../src/renderer/stream/tool-row", async () => {
  const { streamBullet } = await import("../src/renderer/stream/bullet");
  return { streamBullet, StreamToolRows: class {
    constructor(private readonly options: { append(item: HTMLElement): void }) {}
    handle(): void {
      const item = document.createElement("li");
      item.className = "stream-tool";
      item.textContent = "工具操作";
      this.options.append(item);
    }
    setStatus(): void {}
    reset(): void {}
    clear(): void {}
    operations(): number { return 0; }
  } };
});

class TestElement {
  className = "";
  textContent = "";
  dataset: Record<string, string> = {};
  children: TestElement[] = [];
  setAttribute = vi.fn();
  append(...children: TestElement[]): void { this.children.push(...children); }
  replaceChildren(): void { this.children = []; }
  get childNodes(): TestElement[] { return this.children; }
}

let stream: TestElement;
let view: StreamView;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function event(event_type: string, text?: string): TaskEvent {
  return { event_type, data: { agent_id: "main", payload: { text } } } as TaskEvent;
}
function delta(text: string): void { view.handle(event("MODEL_TEXT_DELTA", text)); }
function paint(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}
function contents(): string[] {
  return stream.children.map(item => item.className.includes("stream-text")
    ? item.children[1]!.textContent : item.textContent);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.render.mockImplementation((body: TestElement, raw: string) => { body.textContent = raw; });
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("document", { createElement: () => new TestElement() });
  stream = new TestElement();
  view = createStreamView({ stream: stream as unknown as HTMLOListElement,
    scroller: stream as unknown as HTMLElement, follow: false, loadDiff: async () => [] });
});
afterEach(() => { view.dispose(); vi.unstubAllGlobals(); });

describe("streamed assistant text boundaries", () => {
  it("does not create an empty bullet for empty or whitespace-only deltas", () => {
    for (const text of ["", " ", "\n", "\r\n\t"]) delta(text);
    paint();
    expect(stream.children).toHaveLength(0);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("keeps whitespace and code indentation when real text follows", () => {
    delta("\n");
    delta("```python\n");
    delta("    print('hello')");
    delta("\n```\n");
    paint();
    expect(contents()).toEqual(["\n```python\n    print('hello')\n```\n"]);
  });

  it("flushes text before a tool event in the same frame, preserving event order", () => {
    delta("我先修改文件。");
    view.handle(event("TOOL_REQUESTED"));
    delta("接下来运行测试。");
    view.handle(event("TOOL_REQUESTED"));
    paint();
    expect(contents()).toEqual(["我先修改文件。", "工具操作", "接下来运行测试。", "工具操作"]);
  });

  it("keeps prior text when a new model request arrives before the frame", () => {
    delta("第一段。");
    view.handle(event("MODEL_REQUESTED"));
    delta("第二段。");
    paint();
    expect(contents()).toEqual(["第一段。", "第二段。"]);
  });

  it("drops whitespace between a tool and the next tool without losing later text", () => {
    view.handle(event("TOOL_REQUESTED"));
    delta("\n\n");
    view.handle(event("TOOL_REQUESTED"));
    delta("完成。");
    paint();
    expect(contents()).toEqual(["工具操作", "工具操作", "完成。"]);
  });

  it("does not add an empty final answer row", () => {
    view.finish({ answer: "\n\t ", failure: null, cancelled: false });
    expect(stream.children).toHaveLength(0);
  });

  it("replaces a streamed final answer without duplicating the row", () => {
    delta("最后");
    view.finish({ answer: "最后的回答。", failure: null, cancelled: false });
    paint();
    expect(contents()).toEqual(["最后的回答。"]);
  });

  it("flushes pending text before stopping and ignores subsequent deltas", () => {
    delta("停止前的说明。");
    view.setStatus("CANCELLED");
    delta("停止后不显示。");
    paint();
    expect(stream.children[0]!.children[1]!.textContent).toBe("停止前的说明。");
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it("flushes detached history synchronously instead of leaving an empty bullet", () => {
    delta("保留到历史的文字。");
    const saved = view.detach() as unknown as TestElement[];
    expect(saved[0]!.children[1]!.textContent).toBe("保留到历史的文字。");
    expect(stream.children).toHaveLength(0);
    expect(frames.size).toBe(0);
  });

  it("cancels queued renders on reset without mixing old and new text", () => {
    delta("旧文字");
    view.reset();
    expect(frames.size).toBe(0);
    delta("新文字");
    paint();
    expect(contents()).toEqual(["新文字"]);
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });
});
