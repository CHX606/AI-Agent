from __future__ import annotations

import asyncio
import os

from agents import (
    Agent,
    FunctionTool,
    ItemHelpers,
    ModelSettings,
    RunConfig,
    Runner,
)
from agents.run_config import ModelInputData, ToolExecutionConfig
from openai import (
    AsyncOpenAI,
    OpenAI,
)
from openai.types.shared import Reasoning

from bit_agent.agent.result import AgentRunResult
from bit_agent.context.serialization import to_json_value
from bit_agent.observability import (
    AgentEventType,
)
from bit_agent.observability.model import DiagnosticHttpClient, DiagnosticModel
from bit_agent.observability.usage import record_usage

from .run_protocol import (
    _ContinueTask,
    _ProductHooks,
)


class RunModel:
    async def _compaction_started(self, estimated_tokens: int) -> None:
        # 摘要要额外调用模型，长对话可能要等几分钟；先发事件，界面显示“正在整理对话记录”。
        await self.emit(AgentEventType.CONTEXT_COMPACTING, {"estimated_tokens": estimated_tokens})

    async def prepare_model_input(self, data) -> ModelInputData:
        while True:
            await self.apply_intents(await self.receive_intents())
            prepared = await self.context.prepare(
                self.conversation,
                working_memory=self.memory_tracker.snapshot(),
                tools=self.model_tools,
                on_compaction=self._compaction_started,
            )
            await self.persist()
            if prepared.compacted and prepared.summary is not None:
                await self.emit(
                    AgentEventType.CONTEXT_COMPACTED,
                    {"estimated_tokens": prepared.estimated_tokens},
                )
            # 总结期间也可能收到新要求，不能把已经过时的输入发给模型。
            updates = await self.receive_intents()
            if not updates:
                break
            await self.apply_intents(updates)
        await self.emit(
            AgentEventType.MODEL_REQUESTED,
            {
                "round": self.completed_rounds + 1,
                "estimated_tokens": prepared.estimated_tokens,
                "tool_count": len(self.model_tools),
            },
        )
        return ModelInputData(input=to_json_value(prepared.items), instructions=None)

    async def on_model_response(self, response) -> None:
        self.usage.add("main", response.usage)
        record_usage(self.agent_id, response.usage)
        calls = [item for item in response.output if item.type == "function_call"]
        text = ItemHelpers.text_message_outputs(response.output)
        await self.emit(
            AgentEventType.MODEL_RESPONDED,
            {
                "round": self.completed_rounds + 1,
                "output_items": len(response.output),
                "function_calls": len(calls),
                "output_text_characters": len(text),
            },
        )
        # 必须先保存调用计划再执行工具。断电重启后不会盲目重复写文件。
        self.conversation.extend(response.output)
        await self.archive(list(response.output))
        await self.persist()
        if not calls:
            await self._before_finishing()
            return
        if self.completed_rounds >= self.max_tool_rounds:
            raise RuntimeError(f"Agent 交互超过最大轮数：{self.max_tool_rounds}")
        self._start_round()
        self.batch_invalidated = False
        question = next((item for item in calls if item.name == "ask_user"), None)
        self.skipped_calls = (
            {item.call_id for item in calls if item.call_id != question.call_id}
            if question
            else set()
        )

    async def _before_finishing(self) -> None:
        """模型想结束时：有新要求或未验证的改动就继续，否则放行。"""
        if not self.verification.has_unverified_changes:
            updates = await self.receive_intents(finishing=True)
            if not updates:
                return
            await self.apply_intents(updates)
            raise _ContinueTask()
        if self.completed_rounds >= self.max_tool_rounds:
            raise RuntimeError(f"代码已经修改，但在最大轮数 {self.max_tool_rounds} 内未完成验证")
        if self.verification.reminded():
            raise RuntimeError("代码已经修改，但 Agent 多次被提醒后仍没有运行验证")
        self._start_round()
        await self.emit(AgentEventType.VERIFICATION_REQUIRED, {"round": self.completed_rounds})
        reminder = {"role": "user", "content": self.verification.reminder}
        self.conversation.append(reminder)
        await self.archive([reminder])
        await self.persist()
        raise _ContinueTask()

    async def build_agent(self) -> Agent:
        from . import runtime

        model, settings = self._model_settings(await self._sdk_client())
        return runtime.Agent(
            name=self.agent_id,
            model=DiagnosticModel(
                model,
                task_id=self.task_id,
                session_id=self.thread_id,
                run_id=self.run_id,
                agent_id=self.agent_id,
            ),
            tools=[
                FunctionTool(
                    name=schema["name"],
                    description=schema.get("description", ""),
                    params_json_schema=schema["parameters"],
                    strict_json_schema=schema.get("strict", False),
                    on_invoke_tool=self.invoke_tool,
                )
                for schema in self.model_tools
            ],
            model_settings=settings,
        )

    async def _sdk_client(self):
        sdk_client = self.response_client
        if isinstance(self.response_client, OpenAI):
            sdk_client = await self.stack.enter_async_context(
                AsyncOpenAI(
                    api_key=self.response_client.api_key,
                    base_url=str(self.response_client.base_url),
                    timeout=self.response_client.timeout,
                    max_retries=self.response_client.max_retries,
                    http_client=DiagnosticHttpClient(),
                )
            )
        return sdk_client

    def _model_settings(self, sdk_client):
        from . import runtime

        max_tokens = self.context.policy.reserved_output_tokens
        # 思考程度：没选时不发送，由模型自己决定；两种接口都只用 effort 这一项。
        reasoning = Reasoning(effort=self.reasoning_effort) if self.reasoning_effort else None
        if self.model_api == "chat_completions":
            model = runtime.OpenAIChatCompletionsModel(
                model=self.model_name, openai_client=sdk_client
            )
            # 兼容服务常常不认识 store、parallel_tool_calls；工具本来就逐个执行，省略即可。
            settings = ModelSettings(max_tokens=max_tokens, reasoning=reasoning)
        else:
            model = runtime.OpenAIResponsesModel(model=self.model_name, openai_client=sdk_client)
            settings = ModelSettings(
                parallel_tool_calls=False, store=False, max_tokens=max_tokens, reasoning=reasoning
            )
        return model, settings

    async def run_until_finished(self, agent: Agent) -> AgentRunResult:
        config = RunConfig(
            tracing_disabled=True,  # 不额外上传代码、工具参数或用户数据到追踪服务。
            call_model_input_filter=self.prepare_model_input,
            tool_execution=ToolExecutionConfig(max_function_tool_concurrency=1),
        )
        # 这里不是工具循环。只有产品规则拒绝收尾时才重新交给 SDK 继续。
        while True:
            try:
                options = dict(
                    max_turns=self.max_tool_rounds + 1,
                    hooks=_ProductHooks(self),
                    run_config=config,
                )
                if os.environ.get("BIT_AGENT_STREAMING", "1") == "0":
                    result = await Runner.run(agent, to_json_value(self.conversation), **options)
                else:
                    result = Runner.run_streamed(agent, to_json_value(self.conversation), **options)
                    await self._stream_text(result)
                return await self.finish(str(result.final_output or ""))
            except _ContinueTask:
                continue

    async def _stream_text(self, result) -> None:
        try:
            async for event in result.stream_events():
                if (
                    event.type == "raw_response_event"
                    and event.data.type == "response.output_text.delta"
                ):
                    await self.emit(AgentEventType.MODEL_TEXT_DELTA, {"text": event.data.delta})
        except asyncio.CancelledError:
            # 等正在落盘的工具收尾，不能任务已取消却仍在后台改文件。
            if not result.is_complete:
                result.cancel()
            await asyncio.gather(result.run_loop_task, return_exceptions=True)
            raise
