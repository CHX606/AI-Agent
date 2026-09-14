"""工具发现和调用的统一边界。"""

from typing import Protocol, Self

from bit_agent.tools.models import ToolResult


class ToolProvider(Protocol):
    """为 Agent 提供模型工具定义，并执行模型申请的工具调用。"""

    async def __aenter__(self) -> Self:
        """打开提供者持有的连接或资源。"""
        ...

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: object | None,
    ) -> None:
        """关闭提供者持有的连接或资源。"""
        ...

    async def model_tools(self) -> list[dict[str, object]]:
        """返回可以直接传给模型 API 的工具定义。"""
        ...

    async def call_tool(
        self,
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
    ) -> ToolResult:
        """执行一次工具调用并返回 Bit Agent 标准结果。"""
        ...
