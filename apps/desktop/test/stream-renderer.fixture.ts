import { createStreamView, type FileDiff, type StreamView } from "../src/renderer/stream-view";
import type { TaskEvent } from "../src/shared/contracts";

const patchDiffs: Record<string, FileDiff[]> = {
  "patch-add": [
    { path: "fixture.py", diff: "--- before/fixture.py\n+++ after/fixture.py\n@@ -0,0 +1 @@\n+print('fixture')\n" },
    { path: "obsolete.py", diff: "--- before/obsolete.py\n+++ after/obsolete.py\n@@ -0,0 +1,2 @@\n+old = True\n+unused = True\n" },
  ],
  "patch-update": [
    { path: "fixture.py", diff: "--- before/fixture.py\n+++ after/fixture.py\n@@ -1 +1,2 @@\n-print('fixture')\n+print('updated')\n+answer = 42\n" },
  ],
  "patch-delete": [
    { path: "obsolete.py", diff: "--- before/obsolete.py\n+++ after/obsolete.py\n@@ -1,2 +0,0 @@\n-old = True\n-unused = True\n" },
    { path: "new.py", diff: "--- before/new.py\n+++ after/new.py\n@@ -0,0 +1 @@\n+new = True\n" },
  ],
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function event(view: StreamView, type: string, payload: Record<string, unknown>, agent = "main"): void {
  view.handle({ id: String(Math.random()), event_type: type, data: { agent_id: agent, payload } } as TaskEvent);
}

function operation(view: StreamView, name: string, label: string, id: string,
  summary: string, status = "SUCCESS", agent = "main", errorCode?: string): void {
  const payload = { tool_name: name, tool_call_id: id, operation: { label, target: `${name}.fixture` },
    ...(patchDiffs[id] ? { affected_paths: patchDiffs[id].map(file => file.path) } : {}) };
  event(view, "TOOL_REQUESTED", payload, agent);
  event(view, "TOOL_COMPLETED", { ...payload, status, summary, duration_ms: 1250, error_code: errorCode }, agent);
}

async function runAcceptance() {
  const stream = document.querySelector<HTMLOListElement>("#stream")!;
  const view = createStreamView({ stream, scroller: document.body, follow: false,
    loadDiff: async callId => patchDiffs[callId] ?? [] });
  event(view, "MODEL_TEXT_DELTA", { text: "\n  " });
  operation(view, "read_file", "读取文件", "read-1", "12 行");
  check(stream.querySelectorAll(".stream-text").length === 0, "空白 delta 留下了圆点");
  event(view, "MODEL_TEXT_DELTA", { text: "已经读取，现在修改。" });
  operation(view, "apply_patch", "修改文件", "patch-add", "2 个文件 +3 −0");
  check(stream.querySelector(".stream-text .markdown-body")?.textContent === "已经读取，现在修改。",
    "同一帧出现工具事件时丢失文字");
  operation(view, "apply_patch", "修改文件", "patch-update", "+2 −1");
  // Delete File 的原始补丁不含删除正文，真实差异必须纠正旧摘要中的零删除计数。
  operation(view, "apply_patch", "修改文件", "patch-delete", "2 个文件 +1 −0");
  operation(view, "run_tests", "运行测试", "test-1", "2 个通过");
  operation(view, "run_tests", "运行测试", "test-2", "1 个失败", "ERROR");
  operation(view, "run_tests", "运行测试", "test-3", "3 个通过");
  operation(view, "run_checks", "运行检查", "checks", "ruff 无问题");
  operation(view, "verify_project", "基础检查", "basic", "基础检查通过");
  event(view, "TOOL_REQUESTED", { tool_name: "verify_task", tool_call_id: "verify",
    operation: { label: "独立验收", target: "fixture" } });
  operation(view, "read_file", "读取文件", "nested-read", "3 行", "SUCCESS", "acceptance-fixture");
  event(view, "TOOL_COMPLETED", { tool_name: "verify_task", tool_call_id: "verify", status: "ERROR",
    error_code: "ACCEPTANCE_NOT_VERIFIED", summary: "验收未完成：测试环境缺失",
    operation: { label: "独立验收", target: "fixture" } });
  operation(view, "mcp__fixture__inspect", "外部工具", "mcp", "返回 2 项");
  operation(view, "ask_user", "询问用户", "question", "已收到选择");
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const groups = [...stream.querySelectorAll<HTMLElement>(":scope > .stream-group")];
  check(groups.length === 8, `工具分组数量不符：${groups.length}`);
  for (const group of groups) {
    check(group.querySelector<HTMLElement>(".group-list")!.hidden, "工具没有默认收起");
    check(group.querySelector(".group-head")!.getAttribute("aria-expanded") === "false", "折叠状态不符");
    check(group.querySelector(".group-summary")!.textContent!.trim(), "折叠摘要为空");
  }
  const tests = stream.querySelector<HTMLElement>('[data-tool="run_tests"]')!.closest<HTMLElement>(".stream-group")!;
  check(tests.querySelectorAll(".stream-tool").length === 3, "连续测试没有合并");
  check(tests.querySelector(".group-head")!.textContent!.includes("1 个失败"), "后续成功掩盖了先前失败");
  const verify = stream.querySelector<HTMLElement>('[data-tool="verify_task"]')!.closest<HTMLElement>(".stream-group")!;
  check(verify.dataset.tone === "warning", "未完成验收没有保留警告状态");
  const patch = stream.querySelector<HTMLElement>('[data-tool="apply_patch"]')!.closest<HTMLElement>(".stream-group")!;
  check(patch.querySelectorAll(".stream-tool").length === 3, "连续修改没有合并");
  check(patch.querySelector(".group-summary")!.textContent === "修改了 3 个文件", "修改摘要没有按文件路径去重");
  check(patch.querySelector(".group-outcome")!.textContent!.includes("+6 −3"), "修改摘要没有累计真实增删行数");
  check(patch.querySelector<HTMLElement>(".tool-diff")!.getClientRects().length === 0, "异步差异泄漏到收起的界面");
  (patch.querySelector(".group-head") as HTMLButtonElement).click();
  check(patch.querySelector<HTMLElement>(".tool-diff")!.getClientRects().length > 0, "展开没有显示差异");
  (patch.querySelector(".group-head") as HTMLButtonElement).click();
  (verify.querySelector(".group-head") as HTMLButtonElement).click();
  check(verify.querySelector(".tool-children .stream-group"), "展开后子 Agent 步骤丢失");
  (verify.querySelector(".group-head") as HTMLButtonElement).click();
  event(view, "MODEL_TEXT_DELTA", { text: "\n" });
  view.finish({ answer: "   ", failure: null, cancelled: false });
  check([...stream.querySelectorAll(".stream-text .markdown-body")].every(body => body.textContent!.trim()),
    "空白最终回答生成了空行");
  const result = { passed: true, topLevelGroups: groups.length, readWriteTestCheckVerificationMcpAndQuestionFolded: true,
    failurePreserved: true, warningPreserved: true, nestedStepsPreserved: true,
    asyncDiffFolded: true, changedFilesDeduplicated: true, patchLinesAccumulated: true,
    deletedLinesCounted: true, sameFrameTextPreserved: true, whitespaceHasNoRow: true };
  view.dispose();
  return result;
}

Object.assign(window, { runAcceptance });
