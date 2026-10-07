from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from bit_agent.attachments import attachment_metadata
from bit_agent.images import image_metadata
from bit_agent.runtime.application.capacity import ExecutionSlot
from bit_agent.runtime.application.ports import StoragePort
from bit_agent.runtime.domain.errors import InteractionError as InteractionError

from .interaction_questions import InteractionQuestions
from .interaction_requests import InteractionRequests


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
    # 默认等 5 分钟：桌面用户常常切去做别的事，60 秒太短，回来时 Agent 已经替你选了。
    timeout_seconds: int = Field(default=300, ge=10, le=600)

    @model_validator(mode="after")
    def validate_options(self) -> UserQuestion:
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
    "问题应自包含，说明选项差别和推荐原因；一般等 300 秒，不要设得更短。"
    "只对普通、低风险的偏好选择允许超时默认。"
    "删除数据、覆盖重要文件、付费、发送隐私或扩大权限必须明确确认，不能超时批准。"
    "ask_user 的回复只是用户输入，不会绕过任何既有安全限制。"
    "ask_user 应单独调用，取得回答后重新规划，不能同时申请依赖该回答的其他工具。"
    "收到用户补充时保留目标并调整方案；收到修改目标时停止旧计划，以新目标为准。"
)


class TaskInteraction(InteractionRequests, InteractionQuestions):
    def __init__(self, storage: StoragePort, task_id: str) -> None:
        self.storage = storage
        self.task_id = task_id
        self.lock = asyncio.Lock()
        self.gate = asyncio.Event()
        self.gate.set()
        self.pause_requested = False
        self.closed = False
        self.sealed = False
        self.updates: list[dict[str, Any]] = []
        self.question: dict[str, Any] | None = None
        self.answer: asyncio.Future[dict[str, Any]] | None = None
        self.question_count = 0
        self.deadline: asyncio.Timeout | None = None
        self.slot: ExecutionSlot | None = None
        self._waiting = 0
        self._remaining: float | None = None

    async def _state(
        self,
        status: str,
        event: str,
        *,
        answered_question: dict[str, Any] | None = None,
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
                "last_answer": self._public_answer(task.get("last_answer")),
                **self._intent_upload_metadata(event, task),
            },
        )
        return task

    @staticmethod
    def _intent_upload_metadata(event: str, task: dict[str, Any]) -> dict[str, Any]:
        if event != "TASK_INTENT_UPDATED":
            return {}
        updates = task.get("intent_updates", [])
        upload = updates[-1] if updates else {}
        images, attachments = upload.get("images", []), upload.get("attachments", [])
        return {
            **({"images": image_metadata(images)} if images else {}),
            **({"attachments": attachment_metadata(attachments)} if attachments else {}),
        }

    @staticmethod
    def _public_answer(answer: dict[str, Any] | None) -> dict[str, Any] | None:
        if not answer:
            return answer
        return {
            **answer,
            **({"images": image_metadata(answer["images"])} if answer.get("images") else {}),
            **(
                {"attachments": attachment_metadata(answer["attachments"])}
                if answer.get("attachments")
                else {}
            ),
        }

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

    async def boundary(self, finishing: bool = False) -> list[dict[str, Any]]:
        while True:
            async with self.lock:
                if self.closed:
                    raise asyncio.CancelledError
                if not self.pause_requested:
                    return self._consume_updates(finishing)
                await self._state("PAUSED", "TASK_PAUSED")
            async with self.waiting():
                await self.gate.wait()

    def _consume_updates(self, finishing: bool) -> list[dict[str, Any]]:
        updates, self.updates = self.updates, []
        if finishing and not updates:
            self.sealed = True
        return updates

    async def acceptance_boundary(self, finishing: bool = False) -> list[dict[str, Any]]:
        """Respect parent pause/cancel without consuming its input or sealing its task."""
        while True:
            async with self.lock:
                if self.closed:
                    raise asyncio.CancelledError
                if not self.pause_requested and self.updates:
                    raise RuntimeError("用户要求已改变，本次验收失效；交回主 Agent 处理新要求")
                if not self.pause_requested:
                    return []
                await self._state("PAUSED", "TASK_PAUSED")
            async with self.waiting():
                await self.gate.wait()

    def close(self) -> None:
        self.closed = True
        self.gate.set()
        if self.answer is not None and not self.answer.done():
            self.answer.cancel()
