"""统计一次任务用了多少模型请求和 tokens。

主 Agent、调查子 Agent、独立验收 Agent，以及上下文摘要、提交信息这类辅助请求都记到同一个计量器。
计量器放在 ContextVar 里：子 Agent 和线程里的辅助请求都运行在任务的上下文中，
不需要把它一层层当参数传下去。
"""

from contextvars import ContextVar
from typing import Any


def _count(usage: Any, *names: str) -> int:
    for name in names:
        value = getattr(usage, name, None)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return 0


class UsageMeter:
    def __init__(self) -> None:
        self.by_agent: dict[str, dict[str, int]] = {}

    def add(self, agent: str, usage: Any) -> None:
        """usage 可以是 SDK 的 Usage，也可以是 Responses / Chat Completions 返回的 usage。"""
        if usage is None:
            return
        # 子 Agent 编号形如 research-xxxx、acceptance-xxxx，按类别合并。
        group = agent.split("-", 1)[0] if agent else "main"
        bucket = self.by_agent.setdefault(
            group, {"requests": 0, "input_tokens": 0, "output_tokens": 0}
        )
        bucket["requests"] += _count(usage, "requests") or 1
        bucket["input_tokens"] += _count(usage, "input_tokens", "prompt_tokens")
        bucket["output_tokens"] += _count(usage, "output_tokens", "completion_tokens")

    def snapshot(self) -> dict[str, Any]:
        total = {"requests": 0, "input_tokens": 0, "output_tokens": 0}
        for bucket in self.by_agent.values():
            for key in total:
                total[key] += bucket[key]
        return {**total, "by_agent": {key: dict(value) for key, value in self.by_agent.items()}}


current_meter: ContextVar[UsageMeter | None] = ContextVar("bit_agent_usage_meter", default=None)


def record_usage(agent: str, usage: Any) -> None:
    meter = current_meter.get()
    if meter is not None:
        meter.add(agent, usage)
