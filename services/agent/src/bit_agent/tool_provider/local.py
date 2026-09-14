"""直接调用进程内 Python 工具的提供者。"""

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Self

from bit_agent.llm.tool_schemas import TOOL_SCHEMAS
from bit_agent.tools.models import ToolResult

LocalToolExecutor = Callable[[str, str, str, Path], Awaitable[ToolResult]]


class LocalToolProvider:
    """保留 Bit Agent 原有的本地函数调用模式。"""

    def __init__(self, workspace_root: Path, executor: LocalToolExecutor) -> None:
        self._workspace_root = workspace_root.resolve()
        self._executor = executor

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: object | None,
    ) -> None:
        return None

    async def model_tools(self) -> list[dict[str, object]]:
        return TOOL_SCHEMAS

    async def call_tool(
        self,
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
    ) -> ToolResult:
        return await self._executor(
            tool_name,
            tool_call_id,
            raw_arguments,
            self._workspace_root,
        )
