"""通过 Model Context Protocol 发现和调用工具。"""

import json
from time import perf_counter
from typing import Any, Self

from mcp import Client

from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


def _provider_error(
    tool_call_id: str,
    tool_name: str,
    code: str,
    message: str,
) -> ToolResult:
    return ToolResult(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        status=ToolStatus.ERROR,
        error=ToolError(code=code, message=message, retryable=True),
        metadata=ToolMetadata(duration_ms=0),
    )


class MCPToolProvider:
    """把一个 MCP Server 的 tools 转换为 Agent Function Calling 工具。"""

    def __init__(
        self,
        server: Any,
        *,
        read_timeout_seconds: float = 35.0,
        raise_exceptions: bool = False,
    ) -> None:
        self._client = Client(
            server,
            read_timeout_seconds=read_timeout_seconds,
            raise_exceptions=raise_exceptions,
        )
        self._read_timeout_seconds = read_timeout_seconds
        self._connected = False

    async def __aenter__(self) -> Self:
        await self._client.__aenter__()
        self._connected = True
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: object | None,
    ) -> None:
        try:
            await self._client.__aexit__(exc_type, exc, traceback)
        finally:
            self._connected = False

    def _require_connection(self) -> None:
        if not self._connected:
            raise RuntimeError("MCPToolProvider 必须在 async with 中使用")

    async def model_tools(self) -> list[dict[str, object]]:
        self._require_connection()
        converted: list[dict[str, object]] = []
        cursor: str | None = None

        while True:
            response = await self._client.list_tools(cursor=cursor)
            for tool in response.tools:
                parameters = dict(tool.input_schema)
                properties = parameters.get("properties")
                required = parameters.get("required")
                property_names = set(properties) if isinstance(properties, dict) else set()
                required_names = set(required) if isinstance(required, list) else set()
                strict = bool(property_names) and property_names == required_names
                if strict:
                    parameters["additionalProperties"] = False

                converted.append(
                    {
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description or "",
                        "parameters": parameters,
                        "strict": strict,
                    }
                )

            cursor = response.next_cursor
            if cursor is None:
                return converted

    async def call_tool(
        self,
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
    ) -> ToolResult:
        self._require_connection()
        started = perf_counter()
        try:
            arguments = json.loads(raw_arguments)
        except json.JSONDecodeError as exc:
            return _provider_error(
                tool_call_id,
                tool_name,
                "INVALID_ARGUMENT",
                f"工具参数不是有效 JSON：{exc.msg}",
            )
        if not isinstance(arguments, dict):
            return _provider_error(
                tool_call_id,
                tool_name,
                "INVALID_ARGUMENT",
                "工具参数必须是 JSON object",
            )

        try:
            response = await self._client.call_tool(
                tool_name,
                arguments,
                read_timeout_seconds=self._read_timeout_seconds,
            )
        except Exception as exc:
            return _provider_error(
                tool_call_id,
                tool_name,
                "MCP_CALL_FAILED",
                f"MCP 工具调用失败：{type(exc).__name__}: {exc}",
            )

        payload = response.structured_content
        if isinstance(payload, dict):
            try:
                result = ToolResult.model_validate(payload)
            except ValueError:
                result = None
            if result is not None:
                return result.model_copy(
                    update={
                        "tool_call_id": tool_call_id,
                        "tool_name": tool_name,
                    }
                )

        content = [item.model_dump(mode="json", by_alias=True) for item in response.content]
        text_parts = [
            item["text"]
            for item in content
            if item.get("type") == "text" and isinstance(item.get("text"), str)
        ]
        output: Any = payload
        if output is None:
            output = "\n".join(text_parts) if len(text_parts) == len(content) else content

        duration_ms = max(0, round((perf_counter() - started) * 1000))
        if response.is_error:
            message = "\n".join(text_parts) or "MCP Server 返回工具错误"
            return ToolResult(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                status=ToolStatus.ERROR,
                output=output,
                error=ToolError(code="MCP_TOOL_ERROR", message=message, retryable=True),
                metadata=ToolMetadata(duration_ms=duration_ms),
            )

        return ToolResult(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            status=ToolStatus.SUCCESS,
            output=output,
            metadata=ToolMetadata(duration_ms=duration_ms),
        )
