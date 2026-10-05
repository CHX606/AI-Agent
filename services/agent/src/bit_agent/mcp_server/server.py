"""把 Bit Agent 受控代码工具暴露为标准 MCP tools。"""

import argparse
from pathlib import Path
from uuid import uuid4

from mcp.server import MCPServer

from bit_agent.mcp_server.tool_registration import (
    register_apply_patch,
    register_list_files,
    register_read_file,
    register_run_checks,
    register_run_tests,
    register_search_code,
)
from bit_agent.tools.context import ToolContext

DEFAULT_MCP_TOOL_TIMEOUT_SECONDS = 30.0


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

    register_list_files(server, context)
    register_read_file(server, context)
    register_search_code(server, context)
    register_run_tests(server, context)
    register_run_checks(server, context)
    register_apply_patch(server, context)

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
