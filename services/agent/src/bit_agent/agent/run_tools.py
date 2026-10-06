from __future__ import annotations

import asyncio

from bit_agent.agent.result import ToolCallRecord
from bit_agent.agent.tool_dispatch import (
    result_summary,
    tool_operation,
)
from bit_agent.observability import (
    AgentEventType,
)
from bit_agent.observability.diagnostics import (
    diagnostic_context,
    diagnostic_id,
)
from bit_agent.observability.diagnostics import record as log_record
from bit_agent.tools.models import ToolResult

from .run_protocol import (
    _EXPECTED_REFUSALS,
    _SKIPPED_OUTPUT,
)


class RunTools:
    def _start_round(self) -> None:
        self.completed_rounds += 1
        self.memory_tracker.record_round(self.completed_rounds)

    async def invoke_tool(self, context, arguments) -> str:
        tool_call = context.tool_call
        updates = await self.receive_intents()
        if updates:
            self.batch_invalidated = True
            await self.apply_intents(updates)
        if self.batch_invalidated or tool_call.call_id in self.skipped_calls:
            await self.skip_planned_calls([tool_call])
            return _SKIPPED_OUTPUT

        operation_display = tool_operation(tool_call.name, tool_call.arguments)
        await self._tool_requested(tool_call, operation_display)
        tool_result = await self._call_tool(tool_call)
        record = ToolCallRecord.from_tool_result(
            round_number=self.completed_rounds,
            raw_arguments=tool_call.arguments,
            result=tool_result,
        )
        self.tool_calls.append(record)
        await self._tool_completed(tool_call, record, tool_result, operation_display)
        self.memory_tracker.record_tool_call(record)
        self._remember_user_answer(tool_call.name, tool_result)
        self.verification.observe(tool_call.name, record)

        output = tool_result.model_dump_json()
        # OpenAI Function Calling 是跨边界协议，此处才转换成 JSON。
        self.conversation.append(
            {"type": "function_call_output", "call_id": tool_call.call_id, "output": output}
        )
        await self.archive([self.conversation[-1]])
        await self.persist()
        return output

    async def _tool_requested(self, tool_call, operation_display) -> None:
        await self.emit(
            AgentEventType.TOOL_REQUESTED,
            {
                "round": self.completed_rounds,
                "tool_call_id": tool_call.call_id,
                "tool_name": tool_call.name,
                "argument_characters": len(tool_call.arguments),
                "operation": operation_display,
            },
        )

    async def _tool_completed(self, tool_call, record, tool_result, operation_display) -> None:
        await self.emit(
            AgentEventType.TOOL_COMPLETED,
            {
                "round": self.completed_rounds,
                "tool_call_id": tool_call.call_id,
                "tool_name": tool_call.name,
                "status": record.status,
                "duration_ms": record.metadata.duration_ms,
                "affected_paths": record.metadata.affected_paths,
                "error_code": record.error.code if record.error else None,
                "diagnostic_id": self._log_tool_failure(tool_call, record),
                "operation": operation_display,
                "summary": result_summary(tool_call.name, tool_result, tool_call.arguments),
            },
        )

    async def _call_tool(self, tool_call) -> ToolResult:
        # 放进独立任务并 shield：SDK 取消循环时，已经开始的文件操作要能正常收尾。
        with diagnostic_context(tool_call_id=tool_call.call_id):
            operation = asyncio.create_task(
                self.provider.call_tool(tool_call.name, tool_call.call_id, tool_call.arguments)
            )
        self.active_tool_tasks.add(operation)
        operation.add_done_callback(self.active_tool_tasks.discard)
        return await asyncio.shield(operation)

    def _log_tool_failure(self, tool_call, record: ToolCallRecord) -> str | None:
        """失败的工具调用写一条诊断日志，返回诊断编号；成功时返回 None。"""
        if not record.error:
            return None
        # Existing tool record is the source of truth; output/arguments stay there.
        identifier = diagnostic_id()
        log_record(
            "info" if record.error.code in _EXPECTED_REFUSALS else "warn",
            "tool_failed",
            tool_call_id=tool_call.call_id,
            operation=tool_call.name,
            error_code=record.error.code,
            duration_ms=record.metadata.duration_ms,
            task_id=self.task_id,
            session_id=self.thread_id,
            run_id=self.run_id,
            agent_id=self.agent_id,
            diagnostic_id=identifier,
        )
        return identifier

    def _remember_user_answer(self, tool_name: str, tool_result: ToolResult) -> None:
        if tool_name != "ask_user" or not isinstance(tool_result.output, dict):
            return
        answer_text = tool_result.output.get("text")
        if not isinstance(answer_text, str):
            return
        source = tool_result.output.get("source")
        label = "用户回答：" if source == "user" else "超时暂定方案（非用户授权）："
        finding = label + answer_text
        findings = self.memory_tracker.memory.important_findings
        if finding not in findings:
            self.memory_tracker.memory.important_findings = [*findings, finding]
