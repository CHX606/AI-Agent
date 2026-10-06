import { describe, expect, it, vi } from "vitest";
import { RunStatus, formatDuration } from "../src/renderer/stream/run-status.js";

describe("task stopping presentation", () => {
  it.each(["CANCELLED", "CANCELLATION_REQUESTED", "PAUSE_REQUESTED", "PAUSED"])(
    "shows an immediate static stopped state for %s", value => {
      const status = new RunStatus();
      status.setStatus("RUNNING");
      status.setPhase("读取文件…");
      status.setLoading("正在恢复任务…");
      status.setStatus(value);
      expect(status.presentation()).toEqual({
        hidden: false, state: "stopped", glyph: "■", verb: "已停止", meta: "",
      });
    },
  );

  it("keeps stop final while delayed backend statuses and loading arrive", () => {
    const status = new RunStatus();
    status.setStatus("CANCELLED");
    const stopped = status.presentation();
    for (const value of ["RUNNING", "PAUSE_REQUESTED", "PAUSED", "CANCELLATION_REQUESTED", "FAILED", "IDLE"]) {
      status.setStatus(value);
      status.setLoading("等待当前调用完成");
      status.setPhase("回答中");
      status.tick();
      expect(status.presentation()).toEqual(stopped);
    }
  });

  it("allows the next turn to run after reset", () => {
    const status = new RunStatus();
    status.setStatus("CANCELLED");
    status.reset();
    expect(status.presentation().hidden).toBe(true);
    status.setStartedAt("2026-10-04T00:00:00Z");
    status.setStatus("RUNNING");
    expect(status.presentation(Date.parse("2026-10-04T00:00:12Z"))).toMatchObject({
      hidden: false, state: "running", verb: "思考中…", meta: "12 秒",
    });
  });

  it("shows the stop hint only during the very first run", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); } });
    try {
      const first = new RunStatus();
      first.setStartedAt("2026-10-04T00:00:00Z");
      first.setStatus("RUNNING");
      const at = Date.parse("2026-10-04T00:03:05Z");
      expect(first.presentation(at).meta).toBe("3 分 05 秒 · 点右下角 ■ 可停止");
      expect(first.presentation(at).meta).toContain("可停止");
      first.reset();
      first.setStartedAt("2026-10-04T00:00:00Z");
      first.setStatus("RUNNING");
      expect(first.presentation(at).meta).toBe("3 分 05 秒");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("formats tool durations briefly", () => {
    expect([1_234, 6_300, 11_400, 221_000].map(formatDuration)).toEqual(["1.2 秒", "6.3 秒", "11 秒", "3 分 41 秒"]);
  });

  it("replays resumed legacy tasks without unlocking an explicitly cancelled turn", () => {
    const legacy = new RunStatus();
    legacy.setStatus("PAUSED");
    expect(legacy.resume()).toBe(true);
    expect(legacy.presentation()).toMatchObject({ hidden: false, state: "running", verb: "思考中…" });
    const current = new RunStatus();
    current.setStatus("CANCELLED");
    current.setStatus("PAUSED");
    expect(current.resume()).toBe(false);
    expect(current.presentation()).toMatchObject({ state: "stopped", verb: "已停止" });
  });

  it("keeps ordinary running and question states visible", () => {
    const status = new RunStatus();
    status.setStatus("QUEUED");
    expect(status.presentation()).toMatchObject({ hidden: false, verb: "等待执行…" });
    status.setStatus("WAITING_FOR_INPUT");
    expect(status.presentation()).toMatchObject({ hidden: false, state: "waiting", verb: "等待你的回答" });
  });
});
