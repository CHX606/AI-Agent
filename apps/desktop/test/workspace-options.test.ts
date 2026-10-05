import { describe, expect, it } from "vitest";
import { browseWorkspaceChoice, taskWorkspaceRoot, workspaceChoices } from "../src/renderer/workspace-options.js";

describe("new conversation workspace selection", () => {
  it("does not select the previous folder when a new conversation has no selection", () => {
    const choices = workspaceChoices(["D:\\previous", "D:\\second"], "");
    expect(choices[0]).toMatchObject({ value: "", label: "选择工作区" });
    expect(choices.map(choice => choice.value)).toEqual(["", "D:\\previous", "D:\\second", browseWorkspaceChoice]);
    expect(() => taskWorkspaceRoot("", null)).toThrow("请选择本次对话使用的工作区");
  });

  it("keeps multiple workspaces and distinguishes directories with the same name", () => {
    const choices = workspaceChoices(["D:\\team-one\\repo", "E:\\team-two\\repo"], "");
    expect(choices.filter(choice => choice.label === "repo")).toMatchObject([
      { value: "D:\\team-one\\repo", description: "D:\\team-one\\repo" },
      { value: "E:\\team-two\\repo", description: "E:\\team-two\\repo" },
    ]);
  });

  it("deduplicates Windows paths while keeping the selected spelling first", () => {
    const choices = workspaceChoices(["d:/work/repo/", "D:\\WORK\\repo", "E:\\second"], "D:\\work\\repo");
    expect(choices.map(choice => choice.value)).toEqual(["", "D:\\work\\repo", "E:\\second", browseWorkspaceChoice]);
  });

  it("binds a new task to the explicitly selected workspace", () => {
    expect(taskWorkspaceRoot("  E:\\second  ", null)).toBe("E:\\second");
    expect(taskWorkspaceRoot("d:/work/repo/", "D:\\WORK\\repo")).toBe("d:/work/repo/");
  });

  it("refuses to reuse a session with a different workspace", () => {
    expect(() => taskWorkspaceRoot("E:\\second", "D:\\previous")).toThrow("当前对话已绑定其他工作区");
  });
});
