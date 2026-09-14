"""由确定性工具结果维护 Working Memory。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import uuid4

from bit_agent.memory.models import (
    TestStatus,
    WorkingMemory,
    WorkingMemoryStatus,
)
from bit_agent.tools.models import ToolStatus

if TYPE_CHECKING: #用于类型检查
    from bit_agent.agent.result import ToolCallRecord


def _append_unique(values: list[str], value: str) -> None: #这个函数用于向列表里添加一条内容，但会先清理首尾空白，并避免添加空字符串和重复内容
    normalized = value.strip()
    if normalized and normalized not in values:
        values.append(normalized)


class WorkingMemoryTracker:
    """把工具轨迹转换为不依赖 LLM 猜测的任务状态。"""

    def __init__(self, memory: WorkingMemory) -> None:
        self.memory = memory

    @classmethod
    def create(
        cls,
        objective: str,
        *,
        thread_id: str | None = None,
        constraints: list[str] | None = None,
    ) -> WorkingMemoryTracker:
        return cls(
            WorkingMemory(
                thread_id=thread_id or uuid4().hex, #传了非空编号就使用它，否则生成一个新的随机编号
                objective=objective.strip(), #当前任务目标，去掉首尾空白
                constraints=constraints or [], #任务约束；没传时使用空列表 []
            )
        )

    def record_round(self, round_number: int) -> None:
        self.memory.rounds = max(self.memory.rounds, round_number) #更新轮次为当前轮次和已有轮次的最大值
        self._touch() #更新内存的更新时间为当前时间

    def record_tool_call(self, record: ToolCallRecord) -> None:
        """只从结构化参数和 ToolResult 元数据更新确定性字段。"""
        arguments = record.arguments or {} #先取出这次工具调用的参数；没有参数就用空字典。

        if record.tool_name == "read_file" and isinstance(arguments.get("path"), str): #如果是读取文件的工具调用
            _append_unique(self.memory.files_read, arguments["path"]) #把读取的文件路径添加到内存的 files_read 列表中，避免重复

        if record.tool_name == "apply_patch" and record.status is ToolStatus.SUCCESS: #如果是应用补丁的工具调用，并且成功
            for path in record.metadata.affected_paths: #遍历受影响的文件路径
                _append_unique(self.memory.changed_files, path) #把受影响的文件路径添加到内存的 changed_files 列表中，避免重复
            self.memory.latest_test_status = TestStatus.NEEDS_VERIFICATION #标记最新的测试状态为需要验证

        if record.tool_name == "verify_project":
            self.memory.latest_test_status = (
                TestStatus.PASSED if record.status is ToolStatus.SUCCESS else TestStatus.FAILED
            )
            if record.status is ToolStatus.SUCCESS:
                self.memory.unresolved_errors = [
                    item for item in self.memory.unresolved_errors
                    if not item.startswith("verify_project:")
                ]
            else:
                self._record_error(record)
        elif record.tool_name == "verify_task" and record.status is ToolStatus.SUCCESS:
            self.memory.unresolved_errors = [
                item for item in self.memory.unresolved_errors
                if not item.startswith("verify_task:")
            ]
        elif record.tool_name == "run_tests": #如果是运行测试的工具调用
            if record.status is ToolStatus.SUCCESS: #如果测试运行成功
                self.memory.latest_test_status = TestStatus.PASSED #标记最新的测试状态为通过
                self.memory.unresolved_errors = [] #清空未解决错误列表
            else:
                self.memory.latest_test_status = TestStatus.FAILED #标记最新的测试状态为失败
                self._record_error(record) #记录错误信息到未解决错误列表中
        elif record.status is not ToolStatus.SUCCESS: #如果不是运行测试的工具调用，但状态不是成功
            self._record_error(record) #记录错误信息到未解决错误列表中

        self._touch() #更新内存的更新时间为当前时间

    def finish(self, *, completed: bool) -> None: #标记任务完成状态为已完成或失败
        self.memory.status = (
            WorkingMemoryStatus.COMPLETED #如果任务已完成，标记为已完成
            if completed
            else WorkingMemoryStatus.FAILED #如果任务未完成，标记为失败
        )
        self._touch()

    def snapshot(self) -> WorkingMemory:
        return self.memory.model_copy(deep=True) #返回内存的深拷贝，避免外部修改原始内存对象

    def _record_error(self, record: ToolCallRecord) -> None: #记录工具调用的错误信息到未解决错误列表中
        message = record.error.message if record.error is not None else str(record.output) #获取错误信息，如果没有错误对象，就使用输出内容的字符串表示
        _append_unique(self.memory.unresolved_errors, f"{record.tool_name}: {message}") #把错误信息添加到内存的未解决错误列表中，避免重复

    def _touch(self) -> None: #更新内存的更新时间为当前时间
        self.memory.updated_at = datetime.now(UTC)
