"""使用 LLM 将用户目标拆成可并发的只读调查任务。"""

import asyncio
import json
import re
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from bit_agent.multi_agent.models import (
    PlanSource,
    TaskPlan,
    TaskPlanningResult,
    TaskRoute,
    TaskSpec,
)

PLANNING_INSTRUCTIONS = """
你是 Bit Agent 的意图路由器和任务规划器。用户输入不一定是代码仓库任务，必须先判断路由：
- 寒暄、闲聊、身份或能力询问等不需要访问仓库的内容使用 route="direct"。
- 明确要求创建、查看、分析、修改、测试或构建代码时使用 route="repo"。
- “你好，帮我修复测试”仍是 repo；“在空目录创建项目”也是 repo。

repo 路由需要把任务拆成少量互补的调查任务，交给彼此上下文隔离的子 Agent。子 Agent
只能读取、搜索和运行测试，不能修改文件；最终修改由主 Agent完成。因此任务应侧重定位
实现、理解调用关系、分析测试或复现错误。

返回且只返回一个 JSON object：
{
  "objective": "原始任务",
  "route": "direct 或 repo",
  "tasks": [
    {
      "id": "稳定的小写任务名",
      "role": "角色名",
      "objective": "该子 Agent 的唯一目标",
      "instructions": "需要收集的证据和返回要求",
      "focus_paths": ["可选的相对路径提示"],
      "depends_on": [],
      "max_tool_rounds": 8
    }
  ]
}

规则：
- direct 必须返回空 tasks，不得读取仓库、运行测试或创建子 Agent。
- repo 通常返回 2 到 4 个互补任务，最少 1 个，最多 8 个。
- 没有真实依赖时 depends_on 必须为空，以便并发。
- 不要假设尚未查看过的具体文件一定存在。
- 不要创建内容重复的任务，不要让子 Agent 修改代码。
- id 只能包含小写字母、数字、下划线或连字符，并以字母开头。
""".strip()

_DIRECT_TEXT_NORMALIZER = re.compile(r"[\s,，。.!！?？~～、…]+")
_DIRECT_UTTERANCES = {
    "hi",
    "hello",
    "hey",
    "你好",
    "您好",
    "你好在吗",
    "在吗",
    "嗨",
    "哈喽",
    "有人吗",
    "早上好",
    "上午好",
    "下午好",
    "晚上好",
    "你是谁",
    "你能做什么",
    "你会做什么",
    "介绍一下你自己",
    "谢谢",
    "好的",
}


class TaskPlanningPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    max_attempts: int = Field(default=2, ge=1, le=3)
    request_timeout_seconds: float = Field(default=60.0, gt=0, le=300.0)


@runtime_checkable
class TaskPlanner(Protocol):
    async def plan(self, objective: str) -> TaskPlanningResult: ...


class LLMTaskPlanner:
    """优先使用 LLM 规划，格式持续失败时降级为两个确定性调查任务。"""

    def __init__(
        self,
        response_client: Any,
        model_name: str,
        *,
        policy: TaskPlanningPolicy | None = None,
    ) -> None:
        if not model_name.strip():
            raise ValueError("model_name 不能为空")
        self.response_client = response_client
        self.model_name = model_name
        self.policy = policy or TaskPlanningPolicy()

    async def plan(self, objective: str) -> TaskPlanningResult:
        normalized_objective = objective.strip()
        if not normalized_objective:
            raise ValueError("objective 不能为空")
        if is_direct_conversation(normalized_objective):
            return TaskPlanningResult(
                source=PlanSource.RULE,
                plan=build_direct_plan(normalized_objective),
            )

        errors: list[str] = []
        for _ in range(self.policy.max_attempts):
            correction = ""
            if errors:
                correction = (
                    "\n\n上一次输出无法通过框架校验："
                    f"{errors[-1][:1_000]}。请重新返回完整且合法的 JSON。"
                )
            try:
                response = await asyncio.to_thread(
                    self.response_client.responses.create,
                    model=self.model_name,
                    input=[
                        {"role": "developer", "content": PLANNING_INSTRUCTIONS + correction},
                        {"role": "user", "content": normalized_objective},
                    ],
                    timeout=self.policy.request_timeout_seconds,
                )
                payload = _extract_json_object(response.output_text)
                payload["objective"] = normalized_objective
                plan = TaskPlan.model_validate(payload)
                return TaskPlanningResult(source=PlanSource.LLM, plan=plan)
            except Exception as exc:
                errors.append(f"{type(exc).__name__}: {exc}")

        return TaskPlanningResult(
            source=PlanSource.FALLBACK,
            plan=build_fallback_plan(normalized_objective),
            warnings=[f"LLM 规划失败，已使用确定性计划：{errors[-1]}"],
        )


class StaticTaskPlanner:
    """供评测和调用方注入已经审核的任务计划。"""

    def __init__(self, plan: TaskPlan) -> None:
        self.plan_value = plan

    async def plan(self, objective: str) -> TaskPlanningResult:
        plan = self.plan_value.model_copy(update={"objective": objective.strip()})
        return TaskPlanningResult(source=PlanSource.FALLBACK, plan=plan)


def build_fallback_plan(objective: str) -> TaskPlan:
    return TaskPlan(
        objective=objective,
        tasks=[
            TaskSpec(
                id="implementation_analysis",
                role="代码实现调查员",
                objective="定位与任务相关的实现、调用关系和可能根因",
                instructions="返回具体文件、符号、行号证据和建议验证点，不要修改文件。",
            ),
            TaskSpec(
                id="test_analysis",
                role="测试与复现调查员",
                objective="定位相关测试、失败条件和缺失的边界覆盖",
                instructions="必要时运行现有测试，返回日志摘要和可验证的预期行为。",
            ),
        ],
    )


def build_direct_plan(objective: str) -> TaskPlan:
    """建立不访问仓库、不分发子 Agent 的直接回复计划。"""

    return TaskPlan(objective=objective, route=TaskRoute.DIRECT, tasks=[])


def is_direct_conversation(objective: str) -> bool:
    """识别不会与代码任务混淆的短寒暄，避免一次额外规划请求。"""

    compact = _DIRECT_TEXT_NORMALIZER.sub("", objective).casefold()
    return compact in _DIRECT_UTTERANCES


def _extract_json_object(text: str) -> dict[str, Any]:
    normalized = text.strip()
    if normalized.startswith("```"):
        lines = normalized.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        normalized = "\n".join(lines).strip()

    try:
        payload = json.loads(normalized)
    except json.JSONDecodeError:
        start = normalized.find("{")
        end = normalized.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Planner 没有返回 JSON object") from None
        payload = json.loads(normalized[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("Planner 返回值必须是 JSON object")
    return payload
