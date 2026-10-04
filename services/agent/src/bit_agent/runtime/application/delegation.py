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
from bit_agent.tool_provider.external import ExternalMcpTools
from bit_agent.tools.apply_patch import patch_deletes_files
from bit_agent.tools.models import ToolMetadata, ToolResult, ToolStatus

MAX_DELEGATION_TASKS = 3
MAX_CONCURRENT_INVESTIGATIONS = 3
# 项目自己的验证配置决定“怎样算通过”，改动它必须让用户明确看到并批准。
VERIFICATION_CONFIG_DIRECTORY = ".bit-agent/"

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


def auxiliary_model() -> str | None:
    """配置了辅助模型时返回它的名字；没有配置（或测试替换了模型配置）时返回 None，沿用主模型。"""
    try:
        from bit_agent.llm.client import auxiliary_model_name
    except ImportError:
        return None
    try:
        return auxiliary_model_name()
    except RuntimeError:
        return None


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
        external: ExternalMcpTools | None = None,
        report: Callable[[str, dict], Awaitable[None]] | None = None,
        approved_categories: set[str] | None = None,
    ) -> None:
        super().__init__(root, execute_tool)
        # 只读模式不连接外部工具：它们可能写文件、联网或改动外部系统。
        self.external = external if permission_mode != "read_only" else None
        self.report = report
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
        # 用户选择“本对话内同类操作都批准”的类别（同一对话的各轮共用这个集合）；
        # 删除文件和改验证配置不在此列，每次都问。
        self.approved_categories: set[str] = (
            approved_categories if approved_categories is not None else set()
        )

    @staticmethod
    def _denied(
        tool_call_id: str, tool_name: str, message: str, feedback: str | None
    ) -> ToolResult:
        """拒绝结果；用户写了意见时附上，让 Agent 按意见调整，而不是原样再申请。"""
        if feedback:
            message += f"。用户的意见：{feedback}。请按意见调整方案，不要原样重复申请"
        return tool_error_result(tool_call_id, tool_name, "PERMISSION_DENIED", message)

    async def _approve(
        self, title: str, detail: str, category: str | None = None
    ) -> tuple[bool, str | None]:
        """返回（是否批准，用户拒绝时写的意见）。"""
        if category is not None and category in self.approved_categories:
            return True, None
        if self.interaction is None:
            return False, None
        # 和 Claude Code / Codex 一样：批准在前，拒绝在后；按 1 就是批准本次。
        options = [
            QuestionOption(id="approve", label="批准本次", description="仅允许这一次操作"),
        ]
        if category is not None:
            options.append(
                QuestionOption(
                    id="approve_task",
                    label="本对话内都批准",
                    description="这个对话里同类操作不再询问；删除文件仍会逐次确认",
                )
            )
        options.append(
            QuestionOption(id="reject", label="拒绝", description="不执行；可以在输入框写下原因")
        )
        answer = await self.interaction.ask(
            UserQuestion(
                question=(
                    title
                    + "\n"
                    + detail[:1600]
                    + ("\n补丁预览已截断，请展开下方完整操作详情。" if len(detail) > 1600 else "")
                ),
                options=options,
                # 权限确认必须明确回答、永不超时，这里的推荐项不会被自动采用；界面也不显示“推荐”。
                recommended_option_id="reject",
                requires_confirmation=True,
            ),
            operation={"title": title, "detail": detail},
        )
        if answer.get("source") != "user":
            return False, None
        if category is not None and answer.get("option_id") == "approve_task":
            self.approved_categories.add(category)
            return True, None
        if answer.get("option_id") is None and isinstance(answer.get("text"), str):
            # 用文字回答权限确认：视为拒绝，文字作为意见转给模型。
            return False, answer["text"].strip()[:2000] or None
        return answer.get("option_id") == "approve", None

    async def __aenter__(self) -> "DelegatingToolProvider":
        if self.external is not None:
            await self.external.__aenter__()
            if self.report is not None and (self.external.connected or self.external.failed):
                await self.report(
                    "EXTERNAL_TOOLS_LOADED",
                    {"connected": self.external.connected, "failed": self.external.failed},
                )
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        if self.external is not None:
            await self.external.__aexit__(*exc_info)

    async def model_tools(self) -> list[dict[str, object]]:
        tools = list(await super().model_tools())
        if self.external is not None:
            tools.extend(self.external.model_tools())
        tools.append(VERIFY_SCHEMA)
        if self.acceptance_workspace is not None and self.acceptance_context is not None:
            tools.append(VERIFY_TASK_SCHEMA)
        if self.interaction is not None:
            tools.append(ASK_USER_SCHEMA)
        if self.mode != "off":
            tools.append(DELEGATION_SCHEMA)
        return tools

    async def _call_external(
        self, tool_name: str, tool_call_id: str, raw_arguments: str
    ) -> ToolResult:
        assert self.external is not None
        server = self.external.server_for(tool_name)
        assert server is not None
        # “允许修改”且用户把这个服务标为自动批准时才不问；其他情况逐次确认，可按服务整轮批准。
        if not (self.permission_mode == "edit" and server.auto_approve):
            try:
                shown = json.dumps(json.loads(raw_arguments), ensure_ascii=False, indent=2)
            except (ValueError, TypeError):
                shown = raw_arguments
            approved, feedback = await self._approve(
                f"调用外部工具 {server.name} · {self.external.original_name(tool_name)}",
                "外部工具在本机或远程服务上运行，不在隔离环境中，也不会进入改动审阅。\n" + shown,
                f"mcp:{server.name}",
            )
            if not approved:
                return self._denied(tool_call_id, tool_name, "未批准调用外部工具", feedback)
        return await self.external.call(tool_name, tool_call_id, raw_arguments)

    async def call_tool(self, tool_name: str, tool_call_id: str, raw_arguments: str) -> ToolResult:
        if self.external is not None and self.external.server_for(tool_name) is not None:
            return await self._call_external(tool_name, tool_call_id, raw_arguments)
        changing = tool_name in {
            "apply_patch",
            "run_tests",
            "run_checks",
            "verify_project",
            "verify_task",
        }
        if changing and self.permission_mode == "read_only":
            return tool_error_result(
                tool_call_id, tool_name, "PERMISSION_DENIED", "本轮只读：不能修改文件或运行项目代码"
            )
        # 测试、检查和独立验收都在隔离容器里运行（不联网、不改原工作区），隔离就是安全边界，
        # “逐次确认”模式也不再为它们弹审批；需要确认的是写文件、删除和外部工具。
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
                sensitive = patch_deletes_files(entry["patch"]) or any(
                    name.replace("\\", "/").casefold().startswith(VERIFICATION_CONFIG_DIRECTORY)
                    for name in entry["files"]
                )
                if self.permission_mode == "confirm" or sensitive:
                    files = [str(name) for name in entry["files"]]
                    names = "、".join(files[:3])
                    if len(files) > 3:
                        names += f" 等 {len(files)} 个文件"
                    title = "修改验证配置或删除文件" if sensitive else f"修改 {names}"
                    category = None if sensitive else "patch"
                    approved, feedback = await self._approve(title, entry["patch"], category)
                    if not approved:
                        return self._denied(
                            tool_call_id, tool_name, "用户没有批准这次修改", feedback
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
                originals = self.journal.originals()
                if self.acceptance_workspace is None:
                    self.baseline = await self.verifier(
                        self.root, sorted(self.changed_paths), tool_call_id, originals
                    )
                else:
                    async with self.acceptance_workspace(
                        self.root, self.artifacts / ("baseline-" + uuid4().hex[:12])
                    ) as workspace:
                        self.baseline = await self.verifier(
                            workspace.root, sorted(self.changed_paths), tool_call_id, originals
                        )
                        if not await workspace.unchanged():
                            self.baseline = None
                            raise ValueError("基础检查期间文件发生变化，请重新检查")
                        if isinstance(self.baseline.output, dict):
                            self.baseline = self.baseline.model_copy(
                                update={
                                    "output": {
                                        **self.baseline.output,
                                        "snapshot_id": workspace.snapshot_id,
                                    }
                                }
                            )
                return self.baseline
            except ValueError as exc:
                return tool_error_result(tool_call_id, tool_name, "INVALID_ARGUMENT", str(exc))
        if tool_name == "verify_task":
            try:
                arguments = json.loads(raw_arguments)
                if (
                    not isinstance(arguments, dict)
                    or set(arguments) != {"focus"}
                    or not isinstance(arguments["focus"], str)
                    or len(arguments["focus"]) > 4000
                ):
                    raise ValueError("verify_task 只接受 focus 字符串，最多 4000 字符")
                if self.acceptance_workspace is None or self.acceptance_context is None:
                    raise ValueError("独立验收尚未配置")
                outcome = (
                    self.baseline.output.get("outcome")
                    if self.baseline is not None and isinstance(self.baseline.output, dict)
                    else None
                )
                if outcome in {"UNVERIFIED", "NOT_APPLICABLE"}:
                    # 不是失败：没有能运行的检查时独立验收也跑不了，告诉模型直接收尾。
                    return tool_error_result(
                        tool_call_id,
                        tool_name,
                        "ACCEPTANCE_NOT_APPLICABLE",
                        "不需要独立验收：基础检查没有能运行的检查。不要再调用 verify_task 或 "
                        "verify_project，直接给出最终回答，并说明哪些改动没有经过验证。",
                    )
                if (
                    self.baseline is None
                    or self.baseline.status is not ToolStatus.SUCCESS
                    or not isinstance(self.baseline.output, dict)
                    or self.baseline.output.get("outcome", "PASSED") != "PASSED"
                ):
                    raise ValueError(
                        "请先运行并通过 verify_project 基础检查；"
                        "基础检查无法运行或不需要运行时，不进行独立验收"
                    )
                requirements = await self.acceptance_context()
                result = await run_acceptance(
                    root=self.root,
                    artifacts=self.artifacts,
                    call_id=tool_call_id,
                    context={
                        "requirements": requirements,
                        "changed_paths": sorted(self.changed_paths),
                        "changes": self.journal.public(),
                        "baseline": self.baseline.model_dump(mode="json"),
                        "author_focus_untrusted": arguments["focus"],
                    },
                    workspace_factory=self.acceptance_workspace,
                    sink=self.sink,
                    max_tool_rounds=self.max_tool_rounds,
                    interaction=self.interaction.acceptance_boundary if self.interaction else None,
                )
                if requirements != await self.acceptance_context():
                    return tool_error_result(
                        tool_call_id,
                        tool_name,
                        "ACCEPTANCE_STALE",
                        "验收期间用户要求发生变化，需要按新要求重新验收",
                    )
                verdict = result.output.get("verdict") if isinstance(result.output, dict) else None
                if verdict == "NOT_VERIFIED" and result.error is not None:
                    # 没能得出结论不等于代码有缺陷；代码没变时重验结论不会变，还要再等几分钟。
                    result = result.model_copy(
                        update={
                            "error": result.error.model_copy(
                                update={
                                    "message": result.error.message
                                    + "。独立验收没能得出结论，这不是代码缺陷：不要重复调用 "
                                    "verify_task，直接给出最终回答，说明哪些要求没能验证及原因。"
                                }
                            )
                        }
                    )
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
                        # 只读调查用辅助模型；主 Agent 会检查它的结论。
                        model_name=auxiliary_model(),
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
