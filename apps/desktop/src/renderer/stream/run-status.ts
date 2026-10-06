/** 当前轮展示状态；用户停止后，后台收尾不能让界面重新显示运行。 */
const STOPPED = new Set(["CANCELLED", "CANCELLATION_REQUESTED", "PAUSED", "PAUSE_REQUESTED"]);
const RUNNING = new Set(["SUBMITTING", "QUEUED", "RUNNING"]);
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
export const stopEvents = new Set([
  "TASK_PAUSE_REQUESTED", "TASK_PAUSED", "TASK_CANCELLATION_REQUESTED", "TASK_CANCELLED",
  "CANCELLATION_REQUESTED", "CANCELLED",
]);

export interface StatusPresentation {
  hidden: boolean;
  state: "running" | "waiting" | "stopped";
  glyph: string;
  verb: string;
  meta: string;
}

const minutes = (seconds: number) => `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;

/** 状态行的计时：整秒走动，“22 秒”“3 分 05 秒”。 */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds} 秒` : minutes(seconds);
}

/** 工具用时：短的保留一位小数“6.3 秒”，长的“11 秒”“3 分 41 秒”。 */
export function formatDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds);
  if (value < 10_000) return `${(value / 1000).toFixed(1)} 秒`;
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds} 秒` : minutes(seconds);
}

// “点右下角 ■ 可停止”只在第一次运行时提示，之后状态行只留动作和计时。
const STOP_HINT_KEY = "bit-agent.stop-hint-seen.v1";

function firstStopHint(): boolean {
  try {
    if (localStorage.getItem(STOP_HINT_KEY) === "1") return false;
    localStorage.setItem(STOP_HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export class RunStatus {
  private value = "IDLE";
  private loading: string | null = null;
  private startedAt = Date.now();
  private phase = "思考中";
  private frame = 0;
  stopped = false;
  private paused = false;
  private stopHint: boolean | null = null;

  reset(): void {
    this.value = "IDLE";
    this.loading = null;
    this.startedAt = Date.now();
    this.phase = "思考中";
    this.frame = 0;
    this.stopped = false;
    this.paused = false;
    this.stopHint = null;
  }

  setStatus(value: string): void {
    if (this.stopped) return;
    this.value = value;
    if (value === "RUNNING" && this.stopHint === null) this.stopHint = firstStopHint();
    if (STOPPED.has(value)) {
      this.stopped = true;
      this.paused = value === "PAUSED" || value === "PAUSE_REQUESTED";
      this.loading = null;
    }
  }

  resume(): boolean {
    if (!this.paused) return false;
    this.reset();
    this.setStatus("RUNNING");
    return true;
  }

  setLoading(message: string | null): void { if (!this.stopped) this.loading = message; }
  setPhase(value: string): void { if (!this.stopped) this.phase = value; }
  tick(): void { if (!this.stopped) this.frame += 1; }

  setStartedAt(value: string | null | undefined): void {
    const parsed = value ? Date.parse(value) : NaN;
    if (Number.isFinite(parsed)) this.startedAt = parsed;
  }

  presentation(now = Date.now()): StatusPresentation {
    if (this.stopped) return { hidden: false, state: "stopped", glyph: "■", verb: "已停止", meta: "" };
    if (this.value === "WAITING_FOR_INPUT") {
      return { hidden: false, state: "waiting", glyph: "?", verb: "等待你的回答", meta: "在下方选择或填写" };
    }
    const base: StatusPresentation = { hidden: !RUNNING.has(this.value) && this.loading === null,
      state: "running", glyph: GLYPHS[this.frame % GLYPHS.length]!, verb: this.loading ?? "", meta: "" };
    if (this.loading !== null) return base;
    const queued = this.value === "QUEUED" || this.value === "SUBMITTING";
    return { ...base, verb: queued ? "等待执行…" : `${this.phase.replace(/…$/u, "")}…`,
      meta: formatElapsed(now - this.startedAt) + (this.value === "RUNNING" && this.stopHint ? " · 点右下角 ■ 可停止" : "") };
  }
}
