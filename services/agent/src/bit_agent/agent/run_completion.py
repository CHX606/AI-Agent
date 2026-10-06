from __future__ import annotations

import asyncio

from bit_agent.agent.result import AgentRunResult, AgentRunStatus
from bit_agent.images import image_metadata, user_message
from bit_agent.observability import (
    AgentEventType,
)
from bit_agent.observability.diagnostics import (
    failure,
    public_error,
)

from .run_protocol import (
    _model_failure_message,
)


class RunCompletion:
    async def finish(
        self, final_answer: str | None = None, *, error: str | None = None
    ) -> AgentRunResult:
        error = await self._finish_state(error)
        await self._emit_finished(error)
        return self._result(final_answer, error)

    async def _finish_state(self, error: str | None) -> str | None:
        self.memory_tracker.finish(completed=error is None)
        if self.state_ready:
            try:
                await self.persist()
            except Exception as exc:
                warning = f"本地存档保存失败：{type(exc).__name__}: {exc}"
                self.memory_warnings.append(warning)
                error = error or warning
                self.memory_tracker.finish(completed=False)
        return error

    async def _emit_finished(self, error: str | None) -> None:
        verification = self.verification
        await self.emit(
            AgentEventType.AGENT_COMPLETED if error is None else AgentEventType.AGENT_FAILED,
            {
                "rounds": self.completed_rounds,
                "error": error,
                "changed_files": sorted(verification.changed_files),
                "tests_passed": verification.tests_passed,
                "quality_checks_passed": verification.quality_checks_passed,
                "acceptance_status": verification.acceptance_status,
                "verification_status": verification.status,
            },
        )

    def _result(self, final_answer: str | None, error: str | None) -> AgentRunResult:
        verification = self.verification
        return AgentRunResult(
            thread_id=self.thread_id,
            run_id=self.run_id,
            status=AgentRunStatus.COMPLETED if error is None else AgentRunStatus.FAILED,
            error=error,
            final_answer=final_answer,
            rounds=self.completed_rounds,
            tool_calls=self.tool_calls,
            changed_files=sorted(verification.changed_files),
            tests_passed=verification.tests_passed,
            quality_checks_passed=verification.quality_checks_passed,
            acceptance_status=verification.acceptance_status,
            verification_status=verification.status,
            verification_notes=verification.notes[:20],
            usage={key: value for key, value in self.usage.snapshot().items() if key != "by_agent"},
            working_memory=self.memory_tracker.snapshot(),
            memory_warnings=self.memory_warnings,
            recalled_memory_ids=self.recalled_memory_ids,
            memory_context_tokens=self.memory_context_tokens,
            context_compactions=self.context.compaction_count,
            context_peak_input_tokens=self.context.peak_input_tokens,
            context_last_input_tokens=self.context.last_input_tokens,
            context_artifact_paths=sorted({artifact.path for artifact in self.context.artifacts}),
            context_warnings=list(self.context.warnings),
            event_trace_id=self.event_bus.trace_id,
            event_count=self.event_bus.event_count,
            event_artifact_paths=self.event_bus.artifact_paths,
            event_warnings=[*self.event_bus.warnings, *self.event_warnings],
        )

    async def execute(self) -> AgentRunResult:
        try:
            await self.emit(
                AgentEventType.AGENT_STARTED,
                {
                    "model": self.model_name,
                    "prompt_characters": len(self.prompt),
                    "workspace": str(self.root),
                    **({"images": image_metadata(self.images)} if self.images else {}),
                },
            )
            await self.restore()
            await self.recall_long_term_memory()
            self.conversation.append(user_message(self.prompt.strip(), self.images))
            await self.archive([self.conversation[-1]])
            await self.persist()

            self.provider = await self.stack.enter_async_context(self._provider_source)
            self.model_tools = await self.provider.model_tools()
            # SDK 管模型和工具循环；本类只负责保存、交互和验收规则。
            agent = await self.build_agent()
            return await self.run_until_finished(agent)
        except Exception as exc:
            identifier = failure("agent_failed", exc)
            message = _model_failure_message(exc) or (
                "修改后未完成验证，请检查验证工具和执行结果"
                if self.verification.has_unverified_changes
                else "任务未完成，请查看日志与诊断"
            )
            return await self.finish(error=public_error(identifier, message))
        finally:
            await self._close_tools()

    async def _close_tools(self) -> None:
        # SDK 取消循环不等于文件工具已经退出，释放工作区之前必须等它收尾。
        pending = list(self.active_tool_tasks)
        for operation in pending:
            if not operation.done() and not operation.cancelling():
                operation.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await self.stack.aclose()
