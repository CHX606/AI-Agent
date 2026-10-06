import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { movedWorkspaceOrder, orderedWorkspaceRoots, saveWorkspaceOrder, workspaceOrderKey } from "../src/renderer/workspace-order";
import { knownWorkspaces, rememberWorkspace } from "../src/renderer/workspace-state";

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("sidebar workspace order", () => {
  it("retains the original directory order until the user drags a workspace", () => {
    expect(orderedWorkspaceRoots(["D:/first", "E:/second", "F:/third"]))
      .toEqual(["D:/first", "E:/second", "F:/third"]);
  });

  it("persists manual order across refreshed conversation data and path aliases", () => {
    saveWorkspaceOrder(["E:/second", "D:/first"]);
    expect(orderedWorkspaceRoots(["d:\\FIRST\\", "e:\\SECOND"]))
      .toEqual(["e:\\SECOND", "d:\\FIRST\\"]);
    expect(JSON.parse(values.get(workspaceOrderKey)!)).toEqual(["e:/second", "d:/first"]);
    expect(orderedWorkspaceRoots(["D:/first", "E:/second"]))
      .toEqual(["E:/second", "D:/first"]);
  });

  it("appends new and previously unloaded workspaces after the stored groups", () => {
    saveWorkspaceOrder(["E:/second", "D:/first", "X:/removed"]);
    expect(orderedWorkspaceRoots(["F:/new", "D:/first", "E:/second", "G:/older-page"]))
      .toEqual(["E:/second", "D:/first", "F:/new", "G:/older-page"]);
  });

  it("does not change added directories or impose their thirty-directory limit", () => {
    rememberWorkspace("D:/first"); rememberWorkspace("E:/second");
    const roots = Array.from({ length: 40 }, (_, index) => `D:/project-${index}`);
    saveWorkspaceOrder([...roots].reverse());
    expect(orderedWorkspaceRoots(roots)).toEqual([...roots].reverse());
    expect(knownWorkspaces()).toEqual(["D:/first", "E:/second"]);
  });

  it("moves a workspace before or after another without changing other paths", () => {
    const roots = ["D:/a", "E:/b", "F:/c"];
    expect(movedWorkspaceOrder(roots, "f:\\C", "d:/A", false)).toEqual(["F:/c", "D:/a", "E:/b"]);
    expect(movedWorkspaceOrder(roots, "D:/a", "E:/b", true)).toEqual(["E:/b", "D:/a", "F:/c"]);
    expect(movedWorkspaceOrder(roots, "D:/a", "d:/A", false)).toEqual(roots);
    expect(movedWorkspaceOrder(roots, "missing", "D:/a", false)).toEqual(roots);
  });

  it("rejects corrupt saved data and duplicate identities without inventing directories", () => {
    values.set(workspaceOrderKey, "{");
    expect(orderedWorkspaceRoots(["D:/a", "E:/b"])).toEqual(["D:/a", "E:/b"]);
    values.set(workspaceOrderKey, JSON.stringify(["e:/b", 3, "e:/B", "missing"]));
    expect(orderedWorkspaceRoots(["D:/a", "E:/b", " "])).toEqual(["E:/b", "D:/a"]);
  });

  it("propagates storage failures so the UI can report unsuccessful saving", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("storage full"); } });
    expect(() => saveWorkspaceOrder(["D:/first"])).toThrow("storage full");
  });
});
