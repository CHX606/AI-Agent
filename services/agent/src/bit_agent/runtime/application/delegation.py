"""把分工变成主 Agent 的一个工具，不再先调用另一模型判断任务类型。"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

from bit_agent.agent.limits import DEFAULT_MAX_TOOL_ROUNDS
from bit_agent.agent.runtime import execute_tool, run_agent, tool_error_result
from bit_agent.observability import EventSink
from bit_agent.runtime.application.acceptance import run_acceptance
from bit_agent.runtime.application.interaction import (
    ASK_USER_SCHEMA,
    QuestionOption,
    TaskInteraction,
    UserQuestion,
)
from bit_agent.runtime.application.ports import (
    AcceptanceWorkspaceFactory,
    ChangeJournalPort,
    ProjectVerifier,
)
from bit_agent.runtime.domain.acceptance import VERIFY_TASK_SCHEMA
from bit_agent.runtime.domain.tool_schemas import VERIFY_SCHEMA
from bit_agent.tool_provider import LocalToolProvider, RestrictedToolProvider
from bit_agent.tools.apply_patch import patch_deletes_files
from bit_agent.tools.models import ToolMetadata, ToolResult, ToolStatus

MAX_DELEGATION_TASKS = 3
MAX_CONCURRENT_INVESTIGATIONS = 3

MODE_INSTRUCTIONS = {
    "off": "本轮关闭并行开发分工，由你直接完成实现；独立验收工具 verify_task 仍可使用。",
    "on": (
        "本轮开启多 Agent。先考虑分工，对适合独立调查的部分调用 delegate_tasks。"
        "没有合理分工方式时说明原因，不要为了凑数量创建子任务。"
    ),
    "auto": (
        "你可以按需调用 delegate_tasks。只有分工能带来实际收益时才使用；"
        "普通问题直接回答。不需要先询问另一模型是否应该使用多 Agent。"
    ),
}

DELEGATION_SCHEMA: dict[str, Any] = {
    "type": "function",
    "name": "delegate_tasks",
    "description": (
        f"每次委派 1 到 {MAX_DELEGATION_TASKS} 个独立调查任务，不限制累计委派批次。"
        f"同一主任务最多同时运行 {MAX_CONCURRENT_INVESTIGATIONS} 个调查子 Agent，"
        "超出并发名额的任务等待空位。子 Agent 只能阅读和搜索代码，不能修改文件或执行命令。"
        "你负责检查它们的结果并统一修改代码。每个目标必须自包含，写清需要调查的文件和问题。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_DELEGATION_TASKS,
                "items": {
                    "type": "object",
                    "properties": {
                        "objective": {"type": "string", "minLength": 1, "maxLength": 4000},
                    },
                    "required": ["objective"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["tasks"],
        "additionalProperties": False,
    },
}


class DelegatingToolProvider(LocalToolProvider):
    """主 Agent 可以叫帮手；帮手不能再叫帮手，也不能同时写同一份代码。"""

    def __init__(
        self,
        root: Path,
        mode: str,
        sink: EventSink,
        artifacts: Path,
        interaction: TaskInteraction | None = None,
        *,
        permission_mode: str = "confirm",
        inherited_changes: list[str] | None = None,
        journal: ChangeJournalPort,
        verifier: ProjectVerifier,
        acceptance_workspace: AcceptanceWorkspaceFactory | None = None,
        acceptance_context: Callable[[], Awaitable[dict]] | None = None,
        max_tool_rounds: int = DEFAULT_MAX_TOOL_ROUNDS,
    ) -> None:
        super().__init__(root, execute_tool)
        self.root = root
        self.mode = mode
        self.sink = sink
        self.artifacts = artifacts
        # 同一主任务的所有委派调用共享名额；结束、失败和取消均自动释放。
        self._investigation_slots = asyncio.BoundedSemaphore(MAX_CONCURRENT_INVESTIGATIONS)
        self.interaction = interaction
        self.permission_mode = permission_mode
        self.journal = journal
        self.verifier = verifier
        self.changed_paths = set(inherited_changes or [])
        self.acceptance_workspace = acceptance_workspace
        self.acceptance_context = acceptance_context
        self.baseline: ToolResult | None = None
        self.max_tool_rounds = max_tool_rounds

    async def _approve(self, title: str, detail: str) -> bool:
        if self.interaction is None:
            return False
        answer = await self.interaction.ask(
            UserQuestion(
                question=(
                    title
                    + "\n"
                    + detail[:1600]
                    + ("\n补丁预览已截断，请展开下方完整操作详情。" if len(detail) > 1600 else "")
                ),
                options=[
                    QuestionOption(id="reject", label="拒绝", description="不执行这次操作"),
                    QuestionOption(
                        id="approve", label="批准本次", description="仅允许本次显示的操作"
                    ),
                ],
                recommended_option_id="reject",
                requires_confirmation=True,
            ),
            operation={"title": title, "detail": detail},
        )
        return answer.get("source") == "user" and answer.get("option_id") == "approve"

    async def model_tools(self) -> list[dict[str, object]]:
        tools = list(await super().model_tools())
        tools.append(VERIFY_SCHEMA)
        if self.acceptance_workspace is not None and self.acceptance_context is not None:
            tools.append(VERIFY_TASK_SCHEMA)
        if self.interaction is not None:
            tools.append(ASK_USER_SCHEMA)
        if self.mode != "off":
            tools.append(DELEGATION_SCHEMA)
        return tools

    async def call_tool(self, tool_name: str, tool_call_id: str, raw_arguments: str) -> ToolResult:
        changing = tool_name in {
            "apply_patch", "run_tests", "run_checks", "verify_project", "verify_task"
        }
        if changing and self.permission_mode == "read_only":
            return tool_error_result(
                tool_call_id, tool_name, "PERMISSION_DENIED", "本轮只读：不能修改文件或运行项目代码"
            )
        if tool_name in {"run_tests", "run_checks"} and self.permission_mode == "confirm":
            if not await self._approve("运行项目代码", tool_name + "\n" + raw_arguments):
                return tool_error_result(tool_call_id, tool_name, "PERMISSION_DENIED", "未批准运行")
        if tool_name in {"run_tests", "run_checks"} and self.changed_paths:
            return tool_error_result(
                tool_call_id,
                tool_name,
                "USE_PROJECT_VERIFICATION",
                "修改后请调用 verify_project，由框架选择对应语言的检查",
            )
        if tool_name == "apply_patch":
            try:
                payload = json.loads(raw_arguments)
                entry = self.journal.prepare(tool_call_id, payload["patch"])
                if self.permission_mode == "confirm" or patch_deletes_files(entry["patch"]):
                    if not await self._approve("写入以下补丁", entry["patch"]):
                        return tool_error_result(
                            tool_call_id, tool_name, "PERMISSION_DENIED", "本次修改未获明确批准"
                        )
                self.journal.begin(entry)
                self.baseline = None
                operation = asyncio.create_task(
                    super().call_tool(tool_name, tool_call_id, raw_arguments)
                )
                try:
                    result = await asyncio.shield(operation)
                except asyncio.CancelledError:
                    # 正在落盘的补丁先结束再保存快照，不能留下后台继续写的进程。
                    await operation
                    raise
                finally:
                    self.journal.finish(entry)
                    self.changed_paths.update(entry["files"])
                return result
            except (ValueError, KeyError, TypeError, OSError) as exc:
                return tool_error_result(tool_call_id, tool_name, "PATCH_REJECTED", str(exc))
        if tool_name == "verify_project":
            self.baseline = None
            try:
                if json.loads(raw_arguments) != {}:
                    raise ValueError("verify_project 不接受参数")
                if self.permission_mode == "confirm" and not await self._approve(
                    "运行基础检查",
                    "只在隔离容器内运行测试、检查和构建；不允许项目代码访问网络或改写原工作区。",
                ):
                    return tool_error_result(
                        tool_call_id, tool_name, "PERMISSION_DENIED", "未批准运行项目代码"
                    )
                if self.acceptance_workspace is None:
                    self.baseline = await self.verifier(
                        self.root, sorted(self.changed_paths), tool_call_id
                    )
                else:
                    async with self.acceptance_workspace(
                        self.root, self.artifacts / ("baseline-" + uuid4().hex[:12])
                    ) as workspace:
                        self.baseline = await self.verifier(
                            workspace.root, sorted(self.changed_paths), tool_call_id
                        )
                        if not await workspace.unchanged():
                            self.baseline = None
                            raise ValueError("基础检查期间文件发生变化，请重新检查")
                        if isinstance(self.baseline.output, dict):
                            self.baseline = self.baseline.model_copy(update={"output": {
                                **self.baseline.output, "snapshot_id": workspace.snapshot_id
                            }})
                return self.baseline
            except ValueError as exc:
                return tool_error_result(tool_call_id, tool_name, "INVALID_ARGUMENT", str(exc))
        if tool_name == "verify_task":
            try:
                arguments = json.loads(raw_arguments)
                if (not isinstance(arguments, dict) or set(arguments) != {"focus"}
                        or not isinstance(arguments["focus"], str)
                        or len(arguments["focus"]) > 4000):
                    raise ValueError("verify_task 只接受 focus 字符串，最多 4000 字符")
                if self.acceptance_workspace is None or self.acceptance_context is None:
                    raise ValueError("独立验收尚未配置")
                if self.baseline is None or self.baseline.status is not ToolStatus.SUCCESS:
                    raise ValueError("请先运行并通过 verify_project 基础检查")
                if self.permission_mode == "confirm" and not await self._approve(
                    "启动独立测试 Agent",
                    "额外调用模型，依据原始需求检查改动，在隔离副本补写测试并运行。"
                    "不修改原项目；测试和报告保存为本次任务的验收记录。",
                ):
                    return tool_error_result(tool_call_id, tool_name, "PERMISSION_DENIED",
                                             "未批准独立验收")
                requirements = await self.acceptance_context()
                result = await run_acceptance(
                    root=self.root, artifacts=self.artifacts, call_id=tool_call_id,
                    context={"requirements": requirements,
                             "changed_paths": sorted(self.changed_paths),
                             "changes": self.journal.public(),
                             "baseline": self.baseline.model_dump(mode="json"),
                             "author_focus_untrusted": arguments["focus"]},
                    workspace_factory=self.acceptance_workspace, sink=self.sink,
                    max_tool_rounds=self.max_tool_rounds,
                    interaction=self.interaction.acceptance_boundary if self.interaction else None,
                )
                if requirements != await self.acceptance_context():
                    return tool_error_result(tool_call_id, tool_name, "ACCEPTANCE_STALE",
                                             "验收期间用户要求发生变化，需要按新要求重新验收")
                return result
            except (ValueError, RuntimeError) as exc:
                return tool_error_result(
                    tool_call_id, tool_name, "ACCEPTANCE_NOT_VERIFIED", str(exc)
                )
        if tool_name == "ask_user" and self.interaction is not None:
            try:
                question = UserQuestion.model_validate_json(raw_arguments)
                answer = await self.interaction.ask(question)
            except ValueError as exc:
                return tool_error_result(tool_call_id, tool_name, "INVALID_QUESTION", str(exc))
            return ToolResult(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                status=ToolStatus.SUCCESS,
                output=answer,
                metadata=ToolMetadata(duration_ms=0),
            )
        if tool_name != "delegate_tasks":
            return await super().call_tool(tool_name, tool_call_id, raw_arguments)
        if self.mode == "off":
            return tool_error_result(
                tool_call_id, tool_name, "DELEGATION_LIMIT", "本轮已关闭多 Agent 调查"
            )
        try:
            payload = json.loads(raw_arguments)
            tasks = payload["tasks"]
            if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_DELEGATION_TASKS:
                raise ValueError(f"每批需要 1 到 {MAX_DELEGATION_TASKS} 个子任务")
            if set(payload) != {"tasks"}:
                raise ValueError("存在不支持的参数")
            for task in tasks:
                if not isinstance(task, dict) or set(task) != {"objective"}:
                    raise ValueError("每个子任务只填写 objective")
                if (
                    not isinstance(task["objective"], str)
                    or not 1 <= len(task["objective"].strip()) <= 4000
                ):
                    raise ValueError("子任务目标必须是 1 到 4000 个字符")
        except (ValueError, TypeError, KeyError) as exc:
            return tool_error_result(tool_call_id, tool_name, "INVALID_ARGUMENT", str(exc))

        async def investigate(task: dict[str, str]) -> dict[str, Any]:
            identifier = f"research-{uuid4().hex[:12]}"
            provider = RestrictedToolProvider(
                LocalToolProvider(self.root, execute_tool),
                {"list_files", "read_file", "search_code"},
            )
            try:
                async with self._investigation_slots:
                    result = await run_agent(
                        task["objective"],
                        workspace_root=self.root,
                        tool_provider=provider,
                        agent_id=identifier,
                        event_sink=self.sink,
                        max_tool_rounds=8,
                        context_artifact_directory=self.artifacts / identifier,
                    )
                return {
                    "agent_id": identifier,
                    "objective": task["objective"],
                    "status": result.status,
                    "answer": (result.final_answer or result.error or "")[:12000],
                    "note": "调查意见不是已验证事实，主 Agent 应检查关键结论。",
                }
            except Exception as exc:
                return {"agent_id": identifier, "status": "FAILED", "error": str(exc)[:2000]}

        results = await asyncio.gather(*(investigate(task) for task in tasks))
        return ToolResult(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            status=ToolStatus.SUCCESS,
            output={"investigations": results},
            metadata=ToolMetadata(duration_ms=0),
        )
