"""让正在执行的任务等一等，接收新要求，或向用户问一个问题。"""

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from bit_agent.runtime.application.capacity import ExecutionSlot
from bit_agent.runtime.application.ports import StoragePort
from bit_agent.runtime.domain.errors import InteractionError


class QuestionOption(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    label: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=1000)


class UserQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    question: str = Field(min_length=1, max_length=2000)
    options: list[QuestionOption] = Field(min_length=2, max_length=3)
    recommended_option_id: str
    requires_confirmation: bool
    timeout_seconds: int = Field(default=60, ge=10, le=600)

    @model_validator(mode="after")
    def validate_options(self) -> "UserQuestion":
        identifiers = {option.id for option in self.options}
        if len(identifiers) != len(self.options):
            raise ValueError("选项编号不能重复")
        if self.recommended_option_id not in identifiers:
            raise ValueError("推荐项必须是已有选项")
        return self


ASK_USER_SCHEMA: dict[str, Any] = {
    "type": "function",
    "name": "ask_user",
    "description": (
        "遇到影响任务方向的信息缺口时，向用户提出问题和 2 到 3 个选项。"
        "普通低风险选择可在超时后采用推荐项。涉及删除、覆盖、付费、隐私、权限时，"
        "requires_confirmation 必须为 true，不能默认同意。此工具不授予文件或命令权限。"
    ),
    "parameters": UserQuestion.model_json_schema(),
}

INTERACTION_INSTRUCTIONS = (
    "需要用户选择时调用 ask_user，不要只在最终回答里提问后退出。"
    "问题应自包含，说明选项差别和推荐原因；一般等 60 秒。"
    "只对普通、低风险的偏好选择允许超时默认。"
    "删除数据、覆盖重要文件、付费、发送隐私或扩大权限必须明确确认，不能超时批准。"
    "ask_user 的回复只是用户输入，不会绕过任何既有安全限制。"
    "ask_user 应单独调用，取得回答后重新规划，不能同时申请依赖该回答的其他工具。"
    "收到用户补充时保留目标并调整方案；收到修改目标时停止旧计划，以新目标为准。"
)


class TaskInteraction:
    """只在安全位置等待，不强行打断正在写文件的工具。"""

    def __init__(self, storage: StoragePort, task_id: str) -> None:
        self.storage = storage
        self.task_id = task_id
        self.lock = asyncio.Lock()
        self.gate = asyncio.Event()
        self.gate.set()
        self.pause_requested = False
        self.closed = False
        self.sealed = False
        self.updates: list[dict[str, str]] = []
        self.question: dict[str, Any] | None = None
        self.answer: asyncio.Future[dict[str, Any]] | None = None
        self.question_count = 0
        self.deadline: asyncio.Timeout | None = None
        self.slot: ExecutionSlot | None = None
        self._waiting = 0
        self._remaining: float | None = None

    async def _state(
        self, status: str, event: str, *, answered_question: dict[str, Any] | None = None,
        **changes: Any,
    ) -> dict[str, Any]:
        fields = {"status": status, **changes}
        task = (
            await self.storage.call("answer_task", self.task_id, fields, answered_question)
            if answered_question is not None
            else await self.storage.call("update_task", self.task_id, fields)
        )
        await self.storage.call(
            "event",
            self.task_id,
            event,
            {
                "task_id": self.task_id,
                "status": task["status"],
                "question": task.get("question"),
                "last_answer": task.get("last_answer"),
            },
        )
        return task

    @asynccontextmanager
    async def waiting(self):
        # 等用户不算工作耗时，否则暂停久一点就会把任务判为超时。
        self._waiting += 1
        if self._waiting == 1 and self.deadline is not None:
            when = self.deadline.when()
            self._remaining = (
                None if when is None else max(0.0, when - asyncio.get_running_loop().time())
            )
            if not self.deadline.expired():
                self.deadline.reschedule(None)
        if self._waiting == 1 and self.slot is not None:
            self.slot.release()
        try:
            yield
        finally:
            self._waiting -= 1
            task = asyncio.current_task()
            if (
                self._waiting == 0
                and self.slot is not None
                and task is not None
                and not task.cancelling()
            ):
                await self.slot.acquire()
            if (
                self._waiting == 0
                and self.deadline is not None
                and not self.deadline.expired()
                and self._remaining is not None
            ):
                self.deadline.reschedule(asyncio.get_running_loop().time() + self._remaining)

    async def boundary(self, finishing: bool = False) -> list[dict[str, str]]:
        while True:
            async with self.lock:
                if self.closed:
                    raise asyncio.CancelledError
                if not self.pause_requested:
                    updates, self.updates = self.updates, []
                    if finishing and not updates:
                        self.sealed = True
                    return updates
                await self._state("PAUSED", "TASK_PAUSED")
            async with self.waiting():
                await self.gate.wait()

    async def acceptance_boundary(self, finishing: bool = False) -> list[dict[str, str]]:
        """Respect parent pause/cancel without consuming its input or sealing its task."""
        while True:
            async with self.lock:
                if self.closed:
                    raise asyncio.CancelledError
                if not self.pause_requested:
                    if self.updates:
                        raise RuntimeError("用户要求已改变，本次验收失效；交回主 Agent 处理新要求")
                    return []
                await self._state("PAUSED", "TASK_PAUSED")
            async with self.waiting():
                await self.gate.wait()

    async def request(self, input: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(input, dict):
            raise InteractionError("交互请求必须是对象", 400)
        action = input.get("action")
        async with self.lock:
            task = await self.storage.call("get_task", self.task_id)
            if task is None:
                raise InteractionError("任务不存在", 404)
            if (
                self.closed
                or self.sealed
                or task["status"]
                in {"COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "CANCELLATION_REQUESTED"}
            ):
                raise InteractionError("当前任务已结束或正在收尾，请在同一对话继续提问")

            if action == "pause":
                if self.question is not None:
                    raise InteractionError("Agent 已在等你回答，可以直接回答或修改要求")
                if self.pause_requested:
                    return task
                self.pause_requested = True
                self.gate.clear()
                return await self._state("PAUSE_REQUESTED", "TASK_PAUSE_REQUESTED")

            if action == "resume":
                if self.question is not None:
                    raise InteractionError("请先回答当前问题，或提交新的任务要求")
                if not self.pause_requested:
                    raise InteractionError("当前任务没有暂停")
                result = await self._state(
                    "RUNNING" if task["started_at"] else "QUEUED", "TASK_RESUMED"
                )
                self.pause_requested = False
                self.gate.set()
                return result

            if action in {"supplement", "replace"}:
                if task["status"] not in {"PAUSED", "WAITING_FOR_INPUT"}:
                    raise InteractionError("请先暂停，等当前工具结束后再修改要求")
                text = input.get("text")
                if not isinstance(text, str) or not 1 <= len(text.strip()) <= 4000:
                    raise InteractionError("新要求需要 1 到 4000 个字符", 400)
                updates = list(task.get("intent_updates", []))
                if len(updates) >= 100:
                    raise InteractionError("本轮补充次数过多，请结束后继续新一轮对话")
                update = {
                    "id": uuid4().hex, "kind": action, "text": text.strip(),
                    "accepted_at": datetime.now(UTC).isoformat(),
                }
                result = await self._state(
                    "RUNNING",
                    "TASK_INTENT_UPDATED",
                    intent_updates=[*updates, update],
                    question=None,
                )
                self.updates.append(update)
                self.pause_requested = False
                self.question = None
                if self.answer is not None and not self.answer.done():
                    self.answer.set_result(
                        {"source": "intent_changed", "permission_granted": False}
                    )
                self.gate.set()
                return result

            if action == "answer":
                question, future = self.question, self.answer
                if (
                    question is None
                    or future is None
                    or future.done()
                    or input.get("question_id") != question["id"]
                ):
                    raise InteractionError("这个问题已经结束，请查看最新的问题")
                text, option_id = input.get("text"), input.get("option_id")
                if bool(text) == bool(option_id):
                    raise InteractionError("请选择一个选项，或填写自己的回答", 400)
                if option_id:
                    option = next(
                        (item for item in question["options"] if item["id"] == option_id), None
                    )
                    if option is None:
                        raise InteractionError("选项不存在", 400)
                    text = option["label"] + "：" + option["description"]
                if not isinstance(text, str) or not 1 <= len(text.strip()) <= 4000:
                    raise InteractionError("回答需要 1 到 4000 个字符", 400)
                answer = {
                    "question_id": question["id"],
                    "option_id": option_id,
                    "text": text.strip(),
                    "source": "user",
                    "permission_granted": False,
                }
                result = await self._state(
                    "RUNNING", "USER_ANSWERED", answered_question=question,
                    question=None, last_answer=answer,
                )
                self.question = None
                future.set_result(answer)
                return result
            raise InteractionError("不支持的交互操作", 400)

    async def ask(self, question: UserQuestion, *, operation: dict | None = None) -> dict[str, Any]:
        async with self.lock:
            if self.closed or self.sealed:
                raise InteractionError("任务已经结束")
            if self.question_count >= 20:
                raise InteractionError("本轮提问次数已达上限，请根据已有信息整理结果")
            self.question_count += 1
            public = question.model_dump()
            public["id"] = uuid4().hex
            if operation is not None:
                public["operation"] = operation
            public["expires_at"] = (
                None
                if question.requires_confirmation
                else (datetime.now(UTC) + timedelta(seconds=question.timeout_seconds)).isoformat()
            )
            self.question = public
            future = asyncio.get_running_loop().create_future()
            self.answer = future
            await self._state("WAITING_FOR_INPUT", "USER_QUESTION", question=public)
        try:
            async with self.waiting():
                if question.requires_confirmation:
                    return await future
                try:
                    return await asyncio.wait_for(asyncio.shield(future), question.timeout_seconds)
                except TimeoutError:
                    # 回答和超时争同一把锁，只允许其中一个最终生效。
                    async with self.lock:
                        if future.done():
                            return future.result()
                        option = next(
                            item
                            for item in question.options
                            if item.id == question.recommended_option_id
                        )
                        answer = {
                            "question_id": public["id"],
                            "option_id": option.id,
                            "text": option.label + "：" + option.description,
                            "source": "timeout",
                            "permission_granted": False,
                            "note": "这是超时后的推荐方案，不是用户明确批准高风险操作。",
                        }
                        await self._state(
                            "RUNNING", "QUESTION_DEFAULTED", question=None, last_answer=answer
                        )
                        self.question = None
                        future.set_result(answer)
                        return answer
        finally:
            if self.answer is future:
                self.answer = None

    def close(self) -> None:
        self.closed = True
        self.gate.set()
        if self.answer is not None and not self.answer.done():
            self.answer.cancel()
