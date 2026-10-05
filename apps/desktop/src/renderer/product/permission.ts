import { type ChoiceMenu, icons } from "../choice-menu.js";

export function permissionMode(): "read_only" | "confirm" | "edit" {
  const value = document.querySelector<ChoiceMenu>("#permission-mode")?.value;
  return value === "read_only" || value === "edit" ? value : "confirm";
}

export function mountPermissionControl(): void {
  // 和多 Agent 开关放在一起：这些选项都只影响下一次发送的任务。
  const permission = document.createElement("div");
  permission.className = "permission-control";
  const menu = document.createElement("choice-menu");
  menu.id = "permission-mode";
  permission.append(menu);
  const context = document.querySelector(".composer-context");
  context?.insertBefore(permission, context.querySelector(".composer-tip"));
  // 权限从小到大排列，和 Codex 的“应如何批准”菜单一样；Shift+Tab 在输入框里循环切换。
  menu.configure({
    heading: "应如何批准 Bit Agent 的操作？",
    label: "本轮工具权限",
    value: "confirm",
    choices: [
      { value: "read_only", label: "只读模式", icon: icons.eye, description: "只阅读和搜索代码；不修改文件，也不运行检查" },
      { value: "confirm", label: "逐次确认", icon: icons.hand, description: "写文件和调用外部工具前先问你；测试和检查在禁网沙箱里直接运行" },
      { value: "edit", label: "允许修改", icon: icons.pencil, tone: "caution", description: "直接修改工作区文件；删除、改验证配置和外部工具仍会询问" },
    ],
  });

}
