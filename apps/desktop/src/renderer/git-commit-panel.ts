/** 审阅改动弹窗里的“提交到 Git”：只提交本次任务改过、且还没撤销的文件。 */
import type { TaskRequestInput } from "../shared/contracts.js";

const statusLabels: Record<string, string> = { M: "修改", A: "新增", D: "删除", "??": "新增", R: "重命名" };

export interface GitCommitPanel {
  element: HTMLElement;
  refresh(): Promise<void>;
}

export function createGitCommitPanel(input: TaskRequestInput, report: (value: unknown, success?: boolean) => void): GitCommitPanel {
  const element = document.createElement("section");
  element.className = "git-commit";
  element.setAttribute("aria-label", "提交到 Git");
  let message = "";

  async function refresh(): Promise<void> {
    let status;
    try { status = await window.bitAgent.gitStatus(input); }
    catch (error) { element.replaceChildren(); report(error); return; }
    element.replaceChildren();
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "提交到 Git";
    const meta = document.createElement("span");
    header.append(title, meta);
    element.append(header);
    if (!status.repository) {
      meta.textContent = "工作区不在 Git 仓库里";
      return;
    }
    meta.textContent = status.branch ? `当前分支：${status.branch}` : "当前不在任何分支上";
    if (!status.files.length) {
      const empty = document.createElement("p");
      empty.className = "git-empty";
      empty.textContent = status.task_files.length
        ? "这次任务改过的文件都已提交，或者已经撤销。"
        : "这次任务没有修改文件。";
      element.append(empty);
      return;
    }

    const files = document.createElement("ul");
    files.className = "git-files";
    for (const file of status.files) {
      const item = document.createElement("li");
      const mark = document.createElement("span");
      mark.textContent = statusLabels[file.status] ?? file.status;
      const name = document.createElement("code");
      name.textContent = file.path;
      item.append(mark, name);
      files.append(item);
    }

    const label = document.createElement("label");
    label.className = "git-message";
    label.textContent = "提交信息";
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.spellcheck = false;
    textarea.placeholder = "说明这次改了什么、为什么";
    textarea.value = message;
    textarea.addEventListener("input", () => { message = textarea.value; });
    label.append(textarea);

    const actions = document.createElement("div");
    actions.className = "git-actions";
    const suggest = document.createElement("button");
    suggest.type = "button";
    suggest.className = "button-secondary";
    suggest.textContent = "生成提交信息";
    const branchToggle = document.createElement("label");
    branchToggle.className = "git-branch-toggle";
    const useBranch = document.createElement("input");
    useBranch.type = "checkbox";
    branchToggle.append(useBranch, document.createTextNode("提交到新分支"));
    const branch = document.createElement("input");
    branch.className = "git-branch";
    branch.value = `bit-agent/task-${input.taskId.slice(0, 8)}`;
    branch.spellcheck = false;
    branch.setAttribute("aria-label", "新分支名称");
    branch.hidden = true;
    useBranch.addEventListener("change", () => { branch.hidden = !useBranch.checked; });
    const commit = document.createElement("button");
    commit.type = "button";
    commit.className = "button-primary";
    commit.textContent = `提交 ${status.files.length} 个文件`;
    actions.append(suggest, branchToggle, branch, commit);
    element.append(files, label, actions);

    suggest.addEventListener("click", async () => {
      suggest.disabled = true;
      suggest.textContent = "正在生成…";
      try {
        const result = await window.bitAgent.suggestCommitMessage(input);
        message = textarea.value = result.message;
        if (!result.generated) report("模型暂时不可用，已按任务目标填写草稿，请按需修改。", true);
      } catch (error) { report(error); }
      finally { suggest.disabled = false; suggest.textContent = "生成提交信息"; }
    });
    commit.addEventListener("click", async () => {
      if (!textarea.value.trim()) { textarea.focus(); report("请先填写提交信息"); return; }
      for (const control of [commit, suggest, textarea, useBranch, branch]) control.disabled = true;
      try {
        const result = await window.bitAgent.commitChanges({ ...input, message: textarea.value,
          ...(useBranch.checked && branch.value.trim() ? { branch: branch.value.trim() } : {}) });
        message = "";
        report(`已提交 ${result.commit}${result.branch ? ` 到 ${result.branch}` : ""}，共 ${result.files.length} 个文件。`, true);
        await refresh();
      } catch (error) {
        report(error);
        for (const control of [commit, suggest, textarea, useBranch, branch]) control.disabled = false;
      }
    });
  }

  return { element, refresh };
}
