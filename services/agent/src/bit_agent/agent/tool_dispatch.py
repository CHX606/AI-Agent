"""把模型的工具调用分发到本地工具函数，并生成界面上展示的操作说明。"""

import json
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from bit_agent.tools import (
    apply_patch,
    list_files,
    read_file,
    run_checks,
    run_tests,
    search_code,
)
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus

DEFAULT_TOOL_TIMEOUT_SECONDS = 30.0

ToolHandler = Callable[..., Awaitable[ToolResult]]

TOOL_HANDLERS: dict[str, ToolHandler] = {
    "list_files": list_files,
    "read_file": read_file,
    "search_code": search_code,
    "run_checks": run_checks,
    "run_tests": run_tests,
    "apply_patch": apply_patch,
}


def _argument(name: str, default: str) -> Callable[[dict[str, Any]], str]:
    return lambda arguments: str(arguments.get(name) or default)


def _fixed(text: str) -> Callable[[dict[str, Any]], str]:
    return lambda _arguments: text


def _search_target(arguments: dict[str, Any]) -> str:
    query = str(arguments.get("query") or "")[:120]
    return f"“{query}”" if query else str(arguments.get("path") or "项目代码")


def _checks_target(arguments: dict[str, Any]) -> str:
    check = str(arguments.get("check") or "检查")
    paths = arguments.get("paths")
    if isinstance(paths, list) and paths:
        return f"{check} · {', '.join(str(path) for path in paths[:3])}"
    return check


def _patch_target(arguments: dict[str, Any]) -> str:
    patch = arguments.get("patch")
    target = ""
    if isinstance(patch, str):
        paths = re.findall(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$", patch, re.MULTILINE)
        if not paths:
            paths = re.findall(r"^\+\+\+ (?:b/)?(.+)$", patch, re.MULTILINE)
        target = ", ".join(dict.fromkeys(paths[:3]))
    return target or "项目文件"


def _question_target(arguments: dict[str, Any]) -> str:
    return str(arguments.get("question") or "需要确认下一步")[:160]


def _delegate_target(arguments: dict[str, Any]) -> str:
    tasks = arguments.get("tasks")
    return f"{len(tasks)} 个只读子任务" if isinstance(tasks, list) else "只读子任务"


# 工具名 -> (界面标签, 从参数生成操作对象的函数)。新增工具时在这里加一行。
_OPERATIONS: dict[str, tuple[str, Callable[[dict[str, Any]], str]]] = {
    "list_files": ("查看目录", _argument("path", "项目根目录")),
    "read_file": ("读取文件", _argument("path", "项目根目录")),
    "search_code": ("搜索代码", _search_target),
    "run_tests": ("运行测试", _argument("target", "项目测试")),
    "run_checks": ("运行检查", _checks_target),
    "apply_patch": ("修改文件", _patch_target),
    "verify_project": ("基础检查", _fixed("当前项目")),
    "verify_task": ("独立验收", _fixed("独立测试 Agent")),
    "write_acceptance_test": ("编写验收测试", _argument("filename", "隔离测试文件")),
    "run_acceptance_test": ("运行验收测试", _argument("target", "项目测试集")),
    "submit_acceptance_report": ("提交验收报告", _argument("verdict", "验收结论")),
    "ask_user": ("等待你的选择", _question_target),
    "delegate_tasks": ("启动并行调查", _delegate_target),
}


def tool_operation(tool_name: str, raw_arguments: str) -> dict[str, str]:
    """把工具参数变成适合界面展示的简短说明，不把补丁正文写进事件。"""
    try:
        arguments = json.loads(raw_arguments)
    except (json.JSONDecodeError, TypeError):
        arguments = {}
    if not isinstance(arguments, dict):
        arguments = {}
    label, target = _OPERATIONS.get(tool_name, ("执行操作", _fixed("")))
    return {"kind": tool_name, "label": label, "target": target(arguments)}


def tool_error_result(
    tool_call_id: str,
    tool_name: str,
    code: str,
    message: str,
) -> ToolResult:
    """把调用边界上的错误包装成 Python 工具结果对象。"""
    return ToolResult(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        status=ToolStatus.ERROR,
        error=ToolError(code=code, message=message, retryable=True),
        metadata=ToolMetadata(duration_ms=0),
    )


async def execute_tool(
    tool_name: str,
    tool_call_id: str,
    raw_arguments: str,
    workspace_root: Path,
) -> ToolResult:
    """根据模型给出的工具名称执行对应的 Bit Agent 工具。"""
    handler = TOOL_HANDLERS.get(tool_name)
    if handler is None:
        return tool_error_result(tool_call_id, tool_name, "UNKNOWN_TOOL", f"未知工具：{tool_name}")

    try:
        arguments = json.loads(raw_arguments)
    except json.JSONDecodeError as exc:
        return tool_error_result(
            tool_call_id, tool_name, "INVALID_ARGUMENT", f"工具参数不是有效 JSON：{exc.msg}"
        )

    if not isinstance(arguments, dict):
        return tool_error_result(
            tool_call_id, tool_name, "INVALID_ARGUMENT", "工具参数必须是 JSON object"
        )

    if tool_name == "list_files" and arguments.get("path") == "":
        arguments["max_depth"] = 0

    context = ToolContext(
        workspace_root=workspace_root,
        tool_call_id=tool_call_id,
        timeout_seconds=DEFAULT_TOOL_TIMEOUT_SECONDS,
    )

    try:
        return await handler(context, **arguments)
    except TypeError as exc:
        return tool_error_result(
            tool_call_id, tool_name, "INVALID_ARGUMENT", f"工具参数不符合函数签名：{exc}"
        )
