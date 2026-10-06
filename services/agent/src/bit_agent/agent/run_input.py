from __future__ import annotations

from typing import Any

from bit_agent.context.summarizer import limit_summary_tokens, reconcile_context_summary
from bit_agent.images import readable_objective, user_message, validate_images

from .run_protocol import _SKIPPED_OUTPUT


class RunInput:
    async def receive_intents(self, finishing: bool = False) -> list[dict[str, Any]]:
        return [] if self.interaction is None else await self.interaction(finishing)

    def _update_requirements(self, update: dict[str, Any]) -> bool:
        self.verification.requirements_changed()
        memory = self.memory_tracker.memory
        replacing = update["kind"] == "replace"
        if replacing:
            memory.objective = readable_objective(update["text"])
            memory.constraints = []
        elif update["text"] and update["text"] not in memory.constraints:
            memory.constraints = [*memory.constraints, update["text"]]
        memory.current_plan = []
        summary = self.context.summary or reconcile_context_summary(None, None, memory)
        summary = limit_summary_tokens(
            summary.model_copy(
                update={
                    "objective": memory.objective,
                    "constraints": memory.constraints[-50:],
                    "next_actions": [],
                }
            ),
            self.context.policy.summary_tokens,
        )
        self.context.set_summary(self.conversation, summary)
        return replacing

    async def apply_intents(self, updates: list[dict[str, Any]]) -> None:
        for update in updates:
            if update["id"] in self.applied_interaction_ids:
                continue
            images = validate_images(update.get("images"))
            replacing = self._update_requirements(update)
            label = (
                "[用户修改目标，原目标和原计划作废]" if replacing else "[用户补充要求，保留原目标]"
            )
            message = user_message(label + "\n" + update["text"], images)
            self.conversation.append(message)
            await self.archive([message])
            self.applied_interaction_ids.add(update["id"])
        if updates:
            await self.persist()

    async def skip_planned_calls(self, calls: list[Any]) -> None:
        outputs = [
            {"type": "function_call_output", "call_id": item.call_id, "output": _SKIPPED_OUTPUT}
            for item in calls
        ]
        if outputs:
            self.conversation.extend(outputs)
            await self.archive(outputs)
            await self.persist()
