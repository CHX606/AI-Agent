"""限制 Agent 可见和可调用的工具集合。"""

from typing import Self

from bit_agent.tool_provider.base import ToolProvider
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


class RestrictedToolProvider:
    """在 ToolProvider 外增加确定性的工具白名单。"""

    def __init__(self, provider: ToolProvider, allowed_tools: set[str]) -> None:
        if not allowed_tools:
            raise ValueError("allowed_tools 不能为空")
        self._provider = provider
        self._allowed_tools = frozenset(allowed_tools)
        self._active_provider: ToolProvider | None = None

    async def __aenter__(self) -> Self:
        self._active_provider = await self._provider.__aenter__()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: object | None,
    ) -> None:
        try:
            await self._provider.__aexit__(exc_type, exc, traceback)
        finally:
            self._active_provider = None

    async def model_tools(self) -> list[dict[str, object]]:
        provider = self._active_provider or self._provider
        tools = await provider.model_tools()
        return [tool for tool in tools if tool.get("name") in self._allowed_tools]

    async def call_tool(
        self,
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
    ) -> ToolResult:
        if tool_name not in self._allowed_tools:
            return ToolResult(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                status=ToolStatus.ERROR,
                error=ToolError(
                    code="TOOL_NOT_ALLOWED",
                    message=f"当前 Agent 不允许调用工具：{tool_name}",
                    retryable=False,
                ),
                metadata=ToolMetadata(duration_ms=0),
            )
        provider = self._active_provider or self._provider
        return await provider.call_tool(tool_name, tool_call_id, raw_arguments)
