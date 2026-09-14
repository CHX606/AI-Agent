"""把 Bit Agent 受控代码工具暴露为标准 MCP tools。"""

import argparse
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from mcp.server import MCPServer

from bit_agent.tools import (
    apply_patch,
    list_files,
    read_file,
    run_checks,
    run_tests,
    search_code,
)
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolResult

DEFAULT_MCP_TOOL_TIMEOUT_SECONDS = 30.0


def _serialize(result: ToolResult) -> dict[str, Any]:
    return result.model_dump(mode="json")


def create_mcp_server(
    workspace_root: Path,
    *,
    timeout_seconds: float = DEFAULT_MCP_TOOL_TIMEOUT_SECONDS,
) -> MCPServer:
    """创建一个只允许访问指定工作区的 Bit Agent MCP Server。"""
    root = workspace_root.expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"工作区不存在：{root}")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds 必须大于 0")

    server = MCPServer(
        "bit-agent-tools",
        title="Bit Agent Code Tools",
        description="对一个受信任工作区执行受控的代码读取、搜索、修改和测试。",
        instructions="所有路径都必须相对于创建 Server 时绑定的工作区根目录。",
    )

    def context() -> ToolContext:
        return ToolContext(
            workspace_root=root,
            tool_call_id=f"mcp-{uuid4().hex}",
            timeout_seconds=timeout_seconds,
            task_id="mcp",
        )

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

    @server.tool(
        name="run_tests",
        description=(
            "在受控 Docker 沙箱中运行指定的 pytest 测试文件或测试目录，"
            "返回退出码、标准输出和错误输出。"
        ),
        structured_output=True,
    )
    async def run_tests_tool(target: str) -> dict[str, Any]:
        return _serialize(await run_tests(context(), target))

    @server.tool(
        name="run_checks",
        description=(
            "在受控 Docker 沙箱中对整个工作区运行白名单检查："
            "lint、format、typecheck 或 build。不能执行任意 Shell 命令。"
        ),
        structured_output=True,
    )
    async def run_checks_tool(
        check: Literal["lint", "format", "typecheck", "build"],
        paths: list[str],
    ) -> dict[str, Any]:
        return _serialize(await run_checks(context(), check, paths))

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

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="启动 Bit Agent MCP Server")
    parser.add_argument("--workspace", type=Path, required=True, help="绑定的工作区根目录")
    parser.add_argument(
        "--transport",
        choices=("stdio", "streamable-http"),
        default="stdio",
        help="MCP 传输方式",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    arguments = parser.parse_args()

    server = create_mcp_server(arguments.workspace)
    if arguments.transport == "stdio":
        server.run(transport="stdio")
    else:
        server.run(
            transport="streamable-http",
            host=arguments.host,
            port=arguments.port,
        )


if __name__ == "__main__":
    main()
