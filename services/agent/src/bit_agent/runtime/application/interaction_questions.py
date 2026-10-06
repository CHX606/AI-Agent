from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from bit_agent.runtime.domain.errors import InteractionError


class InteractionQuestions:
    async def ask(self, question: Any, *, operation: dict | None = None) -> dict[str, Any]:
        async with self.lock:
            public, future = await self._open_question(question, operation)
        try:
            async with self.waiting():
                if question.requires_confirmation:
                    return await future
                try:
                    return await asyncio.wait_for(asyncio.shield(future), question.timeout_seconds)
                except TimeoutError:
                    return await self._default_answer(question, public, future)
        finally:
            if self.answer is future:
                self.answer = None

    async def _open_question(self, question: Any, operation: dict | None):
        if self.closed or self.sealed:
            raise InteractionError("任务已经结束")
        if operation is None:
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
        return public, future

    async def _default_answer(self, question: Any, public: dict, future) -> dict[str, Any]:
        # 回答和超时争同一把锁，只允许其中一个最终生效。
        async with self.lock:
            if future.done():
                return future.result()
            option = next(
                item for item in question.options if item.id == question.recommended_option_id
            )
            answer = {
                "question_id": public["id"],
                "option_id": option.id,
                "text": option.label + "：" + option.description,
                "source": "timeout",
                "permission_granted": False,
                "note": "这是超时后的推荐方案，不是用户明确批准高风险操作。",
            }
            await self._state("RUNNING", "QUESTION_DEFAULTED", question=None, last_answer=answer)
            self.question = None
            future.set_result(answer)
            return answer
