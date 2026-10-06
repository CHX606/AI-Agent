"""代码修改后的验证状态机：决定 Agent 什么时候可以结束任务。

规则：
- apply_patch 成功后，改动进入“未验证”状态，之前的测试、检查和验收结果全部作废。
- 普通模式：run_tests 成功，且 run_checks(lint) 覆盖全部改动文件，才算验证完成。
- 独立验收模式：verify_project 负责基础检查，verify_task 结论为 PASSED 才算验证完成。
- verify_project 明确报告“无法自动验证”或“不需要检查”时允许结束，
  结果里记录 UNVERIFIED / NOT_APPLICABLE，不能显示成通过。
- 用户中途补充或修改要求时，独立验收模式下已有改动需要重新验收。
"""

from dataclasses import dataclass, field
from typing import Literal

from bit_agent.agent.result import ToolCallRecord, VerificationStatus
from bit_agent.memory import WorkingMemory
from bit_agent.tools.apply_patch import patch_changed_lines

AcceptanceStatus = Literal["NOT_RUN", "PASSED", "FAILED", "NOT_VERIFIED"]
# 模型连续这么多次想结束却不做任何验证，就停止任务，不再空耗轮数。
MAX_IGNORED_REMINDERS = 3
_VERIFICATION_TOOLS = frozenset({"verify_project", "verify_task", "run_tests", "run_checks"})
# 这些结果说明检查根本没有运行（被拒绝、参数不对、前提不满足）：不算“做过验证”，
# 不能把提醒计数清零，否则模型反复申请同一个被拒绝的检查就会无限循环。
_NOT_RUN_CODES = frozenset(
    {
        "PERMISSION_DENIED",
        "INVALID_ARGUMENT",
        "ACCEPTANCE_NOT_VERIFIED",
        "ACCEPTANCE_NOT_APPLICABLE",
        "USE_PROJECT_VERIFICATION",
    }
)
USER_DECLINED_NOTE = "你没有批准运行检查，这些改动没有经过验证"

VERIFICATION_REQUIRED_MESSAGE = (
    "[框架验证要求] 最近一次代码修改尚未完成验证。"
    "你不能结束任务，必须调用 run_tests，并调用 run_checks(check='lint', paths=[...]) "
    "检查本轮所有修改文件；"
    "只有测试和静态检查都成功后才能给出最终回答。"
    "如果检查失败，请根据日志继续修复并重新验证。"
)
INDEPENDENT_ACCEPTANCE_REQUIRED_MESSAGE = (
    "修改尚未完成验证：先调用 verify_project 运行基础检查，"
    "再调用 verify_task 独立验收。不能把基础检查通过当成需求验收通过。"
)


def check_paths_cover_changes(paths: object, changed_files: set[str]) -> bool:
    """lint 的 paths 参数是否覆盖了全部改动文件（目录前缀或 "." 也算覆盖）。"""
    if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
        return False
    normalized = [path.strip().replace("\\", "/").strip("/") for path in paths]
    for changed_file in changed_files:
        changed = changed_file.replace("\\", "/").strip("/")
        if not any(
            path in {"", "."} or changed == path or changed.startswith(f"{path}/")
            for path in normalized
        ):
            return False
    return True


@dataclass
class VerificationState:
    require_independent_acceptance: bool = False
    changed_files: set[str] = field(default_factory=set)
    changed_lines: int = 0
    has_unverified_changes: bool = False
    tests_passed: bool = False
    quality_checks_passed: bool = False
    acceptance_status: AcceptanceStatus = "NOT_RUN"
    status: VerificationStatus = "NOT_RUN"
    notes: list[str] = field(default_factory=list)
    ignored_reminders: int = 0

    @property
    def reminder(self) -> str:
        """模型想结束但改动还没验证时，发给它的提醒。"""
        if self.require_independent_acceptance:
            return INDEPENDENT_ACCEPTANCE_REQUIRED_MESSAGE
        return VERIFICATION_REQUIRED_MESSAGE

    def restore(self, memory: WorkingMemory, *, patch_interrupted: bool) -> None:
        """从存档恢复；上次 apply_patch 中断时无法确认改了什么，按整个工作区未验证处理。"""
        self.has_unverified_changes = memory.has_unverified_changes
        if self.has_unverified_changes:
            self.changed_files.update(memory.verification_paths)
            self.changed_lines += memory.verification_changed_lines
        if patch_interrupted:
            self.has_unverified_changes = True
            self.changed_files.add(".")

    def save_to(self, memory: WorkingMemory) -> None:
        memory.has_unverified_changes = self.has_unverified_changes
        memory.basic_checks_passed = self.tests_passed and self.quality_checks_passed
        memory.acceptance_status = self.acceptance_status
        memory.verification_paths = (
            sorted(self.changed_files) if self.has_unverified_changes else []
        )
        memory.verification_changed_lines = self.changed_lines if self.has_unverified_changes else 0

    def requirements_changed(self) -> None:
        """用户补充或修改了要求：独立验收模式下，已有改动必须重新验收。"""
        if self.require_independent_acceptance and self.changed_files:
            self.acceptance_status = "NOT_RUN"
            self.has_unverified_changes = True

    def reminded(self) -> bool:
        """又提醒了一次验证；模型连续忽略提醒时返回 True，调用方应停止任务。"""
        self.ignored_reminders += 1
        return self.ignored_reminders > MAX_IGNORED_REMINDERS

    def observe(self, name: str, record: ToolCallRecord) -> None:
        """根据一次工具调用的结果推进状态；name 是模型请求调用的工具名。"""
        success = record.succeeded
        pending = self.has_unverified_changes or bool(self.changed_files)
        code = record.error.code if record.error else None
        if name in _VERIFICATION_TOOLS and code not in _NOT_RUN_CODES:
            self.ignored_reminders = 0

        if name in _VERIFICATION_TOOLS and code == "PERMISSION_DENIED":
            # 用户明确拒绝运行检查：尊重选择，允许结束，如实记为“未验证”，不再催模型反复申请。
            if pending:
                self.has_unverified_changes = False
                self.tests_passed = self.quality_checks_passed = False
                self.status = "UNVERIFIED"
                if USER_DECLINED_NOTE not in self.notes:
                    self.notes = [*self.notes, USER_DECLINED_NOTE]
            return

        if name == "verify_project":
            output = record.output if isinstance(record.output, dict) else {}
            outcome = output.get("outcome")
            self.acceptance_status = "NOT_RUN"
            if outcome in {"UNVERIFIED", "NOT_APPLICABLE"}:
                # 没有能运行的检查：允许结束，但如实记录，不算测试通过。
                self.tests_passed = self.quality_checks_passed = False
                self.has_unverified_changes = False
                self.status = outcome
                self.notes = [
                    f"{item.get('reason')}（{'、'.join(item.get('paths', [])[:5])}）"
                    for item in output.get("unverified", [])
                    if isinstance(item, dict)
                ] + [note for note in output.get("notes", []) if isinstance(note, str)]
                return
            self.tests_passed = self.quality_checks_passed = success
            self.status = "PASSED" if success else "FAILED"
            self.notes = [note for note in output.get("notes", []) if isinstance(note, str)]
            # 自动模式下小改动不做独立验收：基础检查通过即可收尾，并在结果里写明原因。
            skipped = output.get("acceptance") == "skipped"
            if success and skipped and isinstance(output.get("acceptance_reason"), str):
                self.notes = [*self.notes, output["acceptance_reason"]]
            self.has_unverified_changes = pending and (
                not success or (self.require_independent_acceptance and not skipped)
            )
        elif name == "verify_task":
            if code == "ACCEPTANCE_NOT_APPLICABLE":
                # 只是告诉模型这次不需要验收，不改变已有的验证结论。
                return
            if self.status in {"UNVERIFIED", "NOT_APPLICABLE"}:
                # 基础检查已经说明没有能运行的检查，独立验收不适用；
                # 不能因为这次被拒绝的调用又把改动标回“未验证”，否则会在两者之间无限循环。
                return
            verdict = record.output.get("verdict") if isinstance(record.output, dict) else None
            if success and verdict == "PASSED":
                self.acceptance_status = "PASSED"
            elif verdict == "FAILED":
                self.acceptance_status = "FAILED"
            else:
                self.acceptance_status = "NOT_VERIFIED"
            if verdict == "NOT_VERIFIED" and self.tests_passed and self.quality_checks_passed:
                # 验收真的跑了，但没能得出结论（环境、执行器或证据不足），不是代码有缺陷。
                # 代码没变时重验只会得到同样的结论（真实遇到过：每次 3 分钟，连续重验）。
                # 允许如实收尾：基础检查通过、独立验收记为“未完成验证”，并写明原因。
                self.has_unverified_changes = False
                summary = str(record.output.get("summary") or "").split("。")[0][:200]
                note = "独立验收没能完成" + (f"：{summary}" if summary else "")
                if note not in self.notes:
                    self.notes = [*self.notes, note]
                return
            self.has_unverified_changes = pending and not (
                self.tests_passed
                and self.quality_checks_passed
                and self.acceptance_status == "PASSED"
            )
        elif name == "apply_patch":
            if success:
                if not self.has_unverified_changes:
                    self.changed_lines = 0
                self.changed_lines += patch_changed_lines((record.arguments or {}).get("patch"))
                self.changed_files.update(record.metadata.affected_paths)
                self.has_unverified_changes = True
                self.tests_passed = self.quality_checks_passed = False
                self.acceptance_status = "NOT_RUN"
                self.status = "NOT_RUN"
                self.notes = []
        elif name == "run_tests":
            self.tests_passed = success
            self._settle(success, pending)
        elif name == "run_checks" and record.arguments is not None:
            if record.arguments.get("check") != "lint":
                return
            self.quality_checks_passed = success and check_paths_cover_changes(
                record.arguments.get("paths"), self.changed_files
            )
            self._settle(success, pending)

    def _settle(self, success: bool, pending: bool) -> None:
        if not success:
            self.has_unverified_changes = pending
            self.status = "FAILED"
        elif self.tests_passed and self.quality_checks_passed:
            self.status = "PASSED"
            if not self.require_independent_acceptance:
                self.has_unverified_changes = False
