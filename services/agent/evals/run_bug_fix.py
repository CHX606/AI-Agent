"""使用真实模型运行一次 Calculator Bug-Fix 端到端评测。"""

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

from bit_agent.agent import AgentRunResult, run_agent
from bit_agent.evals import EvalCase, EvalRunner
from bit_agent.tool_provider import MCPToolProvider
from mcp import StdioServerParameters


async def run_mcp_agent(
    prompt: str,
    *,
    workspace_root: Path,
    **options: Any,
) -> AgentRunResult:
    """通过独立 stdio MCP Server 运行现有 Agent 循环。"""
    server = StdioServerParameters(
        command=sys.executable,
        args=[
            "-m",
            "bit_agent.mcp_server",
            "--workspace",
            str(workspace_root),
        ],
    )
    return await run_agent(
        prompt,
        workspace_root=workspace_root,
        tool_provider=MCPToolProvider(server),
        **options,
    )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tool-provider",
        choices=("local", "mcp"),
        default="local",
        help="Agent 使用进程内工具或独立 stdio MCP Server",
    )
    arguments = parser.parse_args()

    service_root = Path(__file__).resolve().parents[1]
    repository_root = service_root.parents[1]
    case = EvalCase(
        name=f"bug-fix-calculator-{arguments.tool_provider}",
        prompt=(
            "这个项目存在一个功能错误，并且有测试无法通过。"
            "请自行定位问题、修复代码并运行测试验证，不要猜测文件内容。"
        ),
        fixture_path=service_root / "evals" / "fixtures" / "bug_fix_calculator",
        test_target="tests",
        allowed_paths=["calculator.py"],
        immutable_paths=["tests/**", "README.md", ".git/**", ".env", ".env.*"],
    )
    runner = EvalRunner(
        repository_root / "artifacts" / "evals",
        agent_runner=run_mcp_agent if arguments.tool_provider == "mcp" else run_agent,
    )
    result = await runner.run(case)
    print("最终评测结果：")
    print(result.model_dump_json(indent=2))


if __name__ == "__main__":
    asyncio.run(main())
