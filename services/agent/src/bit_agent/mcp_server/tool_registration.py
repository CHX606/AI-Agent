"""注册工作区读取、修改与 OS 沙箱验证 MCP 工具。"""

from collections.abc import Callable
from typing import Any, Literal

from mcp.server import MCPServer

from bit_agent.tools.apply_patch import apply_patch
from bit_agent.tools.context import ToolContext
from bit_agent.tools.list_files import list_files
from bit_agent.tools.models import ToolResult
from bit_agent.tools.read_file import read_file
from bit_agent.tools.run_checks import run_checks
from bit_agent.tools.run_tests import run_tests
from bit_agent.tools.search_code import search_code

ContextFactory = Callable[[], ToolContext]


def _serialize(result: ToolResult) -> dict[str, Any]:
    return result.model_dump(mode="json")


def register_list_files(server: MCPServer, context: ContextFactory) -> None:
    @server.tool(
        name="list_files",
        description=(
            "列出工作区指定目录下的文件和子目录，不读取文件内容。"
            "查看工作区根目录时必须先使用 max_depth=0，之后再进入需要的具体目录。"
        ),
        structured_output=True,
    )
    async def list_files_tool(
        path: str,
        max_depth: Literal[0, 1, 2, 3, 4, 5],
    ) -> dict[str, Any]:
        if path == "":
            max_depth = 0
        return _serialize(await list_files(context(), path, max_depth=max_depth))


def register_read_file(server: MCPServer, context: ContextFactory) -> None:
    @server.tool(
        name="read_file",
        description=(
            "读取工作区内指定 UTF-8 文本文件的内容，并返回带行号的文本。"
            "只能读取文件，不能读取目录。"
        ),
        structured_output=True,
    )
    async def read_file_tool(path: str) -> dict[str, Any]:
        return _serialize(await read_file(context(), path))


def register_search_code(server: MCPServer, context: ContextFactory) -> None:
    @server.tool(
        name="search_code",
        description=(
            "使用 ripgrep 正则表达式在工作区代码中搜索匹配内容，"
            "返回文件路径、行号、列号和匹配文本。"
        ),
        structured_output=True,
    )
    async def search_code_tool(query: str, path: str) -> dict[str, Any]:
        return _serialize(await search_code(context(), query, path))


def register_run_tests(server: MCPServer, context: ContextFactory) -> None:
    @server.tool(
        name="run_tests",
        description=(
            "在受控 OS 沙箱中运行指定的 pytest 测试文件或测试目录，返回退出码、标准输出和错误输出。"
        ),
        structured_output=True,
    )
    async def run_tests_tool(target: str) -> dict[str, Any]:
        return _serialize(await run_tests(context(), target))


def register_run_checks(server: MCPServer, context: ContextFactory) -> None:
    @server.tool(
        name="run_checks",
        description=(
            "在受控 OS 沙箱中对整个工作区运行白名单检查："
            "lint、format、typecheck 或 build。不能执行任意 Shell 命令。"
        ),
        structured_output=True,
    )
    async def run_checks_tool(
        check: Literal["lint", "format", "typecheck", "build"],
        paths: list[str],
    ) -> dict[str, Any]:
        return _serialize(await run_checks(context(), check, paths))


def register_apply_patch(server: MCPServer, context: ContextFactory) -> None:
    @server.tool(
        name="apply_patch",
        description=(
            "向工作区安全地应用文本补丁，用于创建、修改或删除文件。"
            "支持标准 Git unified diff 和 Begin Patch 格式。"
        ),
        structured_output=True,
    )
    async def apply_patch_tool(patch: str) -> dict[str, Any]:
        return _serialize(await apply_patch(context(), patch))
