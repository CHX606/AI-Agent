from __future__ import annotations

from typing import Any
from uuid import uuid4

from bit_agent.attachments import validate_attachments, validate_upload_limits
from bit_agent.images import validate_images
from bit_agent.runtime.domain.clock import accepted_at
from bit_agent.runtime.domain.errors import InteractionError


def message_input(
    input: dict[str, Any], label: str
) -> tuple[str, list[dict[str, str]], list[dict[str, str]]]:
    try:
        images = validate_images(input.get("images"))
        attachments = validate_attachments(input.get("attachments"))
        validate_upload_limits(images, attachments)
    except ValueError as exc:
        raise InteractionError(str(exc), 400) from exc
    text = input.get("text", "")
    if (
        not isinstance(text, str)
        or len(text.strip()) > 4000
        or not (text.strip() or images or attachments)
    ):
        raise InteractionError(f"{label}需要 1 到 4000 个字符，或至少一个图片/附件", 400)
    return text.strip(), images, attachments


class InteractionRequests:
    async def request(self, input: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(input, dict):
            raise InteractionError("交互请求必须是对象", 400)
        async with self.lock:
            task = await self.storage.call("get_task", self.task_id)
            self._check_request_state(task)
            action = input.get("action")
            if action == "pause":
                return await self._pause(task)
            if action == "resume":
                return await self._resume(task)
            if action in {"supplement", "replace"}:
                return await self._update_intent(task, input)
            if action == "answer":
                return await self._answer_question(input)
            raise InteractionError("不支持的交互操作", 400)

    def _check_request_state(self, task: dict[str, Any] | None) -> None:
        if task is None:
            raise InteractionError("任务不存在", 404)
        if (
            self.closed
            or self.sealed
            or task["status"]
            in {"COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "CANCELLATION_REQUESTED"}
        ):
            raise InteractionError("当前任务已结束或正在收尾，请在同一对话继续提问")

    async def _pause(self, task: dict[str, Any]) -> dict[str, Any]:
        if self.question is not None:
            raise InteractionError("Agent 已在等你回答，可以直接回答或修改要求")
        if self.pause_requested:
            return task
        self.pause_requested = True
        self.gate.clear()
        return await self._state("PAUSE_REQUESTED", "TASK_PAUSE_REQUESTED")

    async def _resume(self, task: dict[str, Any]) -> dict[str, Any]:
        if self.question is not None:
            raise InteractionError("请先回答当前问题，或提交新的任务要求")
        if not self.pause_requested:
            raise InteractionError("当前任务没有暂停")
        result = await self._state("RUNNING" if task["started_at"] else "QUEUED", "TASK_RESUMED")
        self.pause_requested = False
        self.gate.set()
        return result

    async def _update_intent(self, task: dict[str, Any], input: dict[str, Any]) -> dict[str, Any]:
        text, images, attachments = message_input(input, "新要求")
        updates = list(task.get("intent_updates", []))
        if len(updates) >= 100:
            raise InteractionError("本轮补充次数过多，请结束后继续新一轮对话")
        update = {
            "id": uuid4().hex,
            "kind": input["action"],
            "text": text,
            "accepted_at": accepted_at(),
            **({"images": images} if images else {}),
            **({"attachments": attachments} if attachments else {}),
        }
        result = await self._state(
            "RUNNING" if task["started_at"] else "QUEUED",
            "TASK_INTENT_UPDATED",
            intent_updates=[*updates, update],
            question=None,
        )
        self.updates.append(update)
        self.pause_requested = False
        self.question = None
        if self.answer is not None and not self.answer.done():
            self.answer.set_result({"source": "intent_changed", "permission_granted": False})
        self.gate.set()
        return result

    def _question_answer(self, input: dict[str, Any], question: dict[str, Any]) -> dict[str, Any]:
        option_id = input.get("option_id")
        if option_id:
            if input.get("text") or input.get("images") or input.get("attachments"):
                raise InteractionError("请选择一个选项，或填写自己的回答", 400)
            option = next((item for item in question["options"] if item["id"] == option_id), None)
            if option is None:
                raise InteractionError("选项不存在", 400)
            text, images, attachments = option["label"] + "：" + option["description"], [], []
        else:
            text, images, attachments = message_input(input, "回答")
        return {
            "question_id": question["id"],
            "option_id": option_id,
            "text": text,
            "source": "user",
            "permission_granted": False,
            **({"images": images} if images else {}),
            **({"attachments": attachments} if attachments else {}),
        }

    async def _answer_question(self, input: dict[str, Any]) -> dict[str, Any]:
        question, future = self.question, self.answer
        if (
            question is None
            or future is None
            or future.done()
            or input.get("question_id") != question["id"]
        ):
            raise InteractionError("这个问题已经结束，请查看最新的问题")
        answer = self._question_answer(input, question)
        result = await self._state(
            "RUNNING",
            "USER_ANSWERED",
            answered_question=question,
            question=None,
            last_answer=answer,
        )
        if answer.get("images") or answer.get("attachments"):
            self.updates.append(
                {
                    "id": "answer_" + question["id"],
                    "kind": "supplement",
                    "text": answer["text"],
                    **({"images": answer["images"]} if answer.get("images") else {}),
                    **({"attachments": answer["attachments"]} if answer.get("attachments") else {}),
                }
            )
        self.question = None
        public = self._public_answer(answer)
        future.set_result(public)
        return result
