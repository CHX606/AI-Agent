"""用户在桌面“外部工具”里配置的 MCP Server。

每个任务开始时按配置逐个连接，把它们的工具以 mcp__<服务名>__<工具名> 的名字交给主 Agent。
连不上的服务只记一条提醒，不影响任务本身。连接在同一个 asyncio 任务里打开和关闭
（MCP 客户端基于 anyio，要求这样做），所以这里按顺序连接，不并发。

配置只来自用户本机的设置，不读取项目里的文件：stdio 服务会在本机直接运行命令，
不能让一个克隆下来的仓库替用户决定运行什么。
"""

import asyncio
import re
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self
from urllib.parse import urlparse

from mcp import StdioServerParameters
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client

from bit_agent.tool_provider.mcp import MCPToolProvider
from bit_agent.tools.models import ToolResult

PREFIX = "mcp__"
SERVER_NAME = re.compile(r"[A-Za-z0-9_-]{1,32}")
MAX_SERVERS = 10
HEADER_NAME = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}")
# 由 HTTP 客户端和 MCP 协议自己管理的请求头，用户填写会破坏连接。
RESERVED_HEADERS = {
    "host",
    "content-length",
    "content-type",
    "accept",
    "connection",
    "transfer-encoding",
    "mcp-session-id",
    "mcp-protocol-version",
}


class ExternalServerConfigError(ValueError):
    """外部工具配置不合法。"""


@dataclass(frozen=True)
class ExternalServer:
    name: str
    transport: Any  # StdioServerParameters、URL 字符串，测试中也可以是进程内 Server
    auto_approve: bool = False


def _strings(value: object, label: str, *, limit: int, size: int = 1000) -> list[str]:
    if value is None:
        return []
    if (
        not isinstance(value, list)
        or len(value) > limit
        or any(not isinstance(item, str) or len(item) > size or "\0" in item for item in value)
    ):
        raise ExternalServerConfigError(f"{label} 必须是最多 {limit} 个字符串")
    return list(value)


def validate_servers(raw: object) -> list[dict[str, Any]]:
    """检查并规范化配置；返回可以原样保存的列表。"""
    if not isinstance(raw, list) or len(raw) > MAX_SERVERS:
        raise ExternalServerConfigError(f"最多配置 {MAX_SERVERS} 个外部工具服务")
    servers: list[dict[str, Any]] = []
    names: set[str] = set()
    allowed = {
        "name",
        "type",
        "command",
        "args",
        "env",
        "url",
        "headers",
        "enabled",
        "auto_approve",
    }
    for item in raw:
        if not isinstance(item, dict) or not set(item) <= allowed:
            raise ExternalServerConfigError("服务配置只支持 " + "、".join(sorted(allowed)))
        name = item.get("name")
        if not isinstance(name, str) or not SERVER_NAME.fullmatch(name):
            raise ExternalServerConfigError("服务名只能是 1 到 32 个字母、数字、_ 或 -")
        if name.casefold() in names:
            raise ExternalServerConfigError(f"服务名重复：{name}")
        names.add(name.casefold())
        kind = item.get("type")
        server: dict[str, Any] = {
            "name": name,
            "type": kind,
            "enabled": item.get("enabled", True) is True,
            "auto_approve": item.get("auto_approve", False) is True,
        }
        if kind == "stdio":
            command = item.get("command")
            if not isinstance(command, str) or not command.strip() or len(command) > 500:
                raise ExternalServerConfigError(f"{name}：请填写要运行的命令")
            env = item.get("env") or {}
            if (
                not isinstance(env, dict)
                or len(env) > 50
                or any(
                    not isinstance(key, str)
                    or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,99}", key)
                    or not isinstance(value, str)
                    or len(value) > 4000
                    for key, value in env.items()
                )
            ):
                raise ExternalServerConfigError(f"{name}：环境变量格式不正确")
            server.update(
                command=command.strip(),
                args=_strings(item.get("args"), f"{name} 的参数", limit=50),
                env=dict(env),
            )
        elif kind == "http":
            url = item.get("url")
            parsed = urlparse(url) if isinstance(url, str) else None
            if (
                parsed is None
                or len(url) > 2000
                or parsed.username
                or parsed.password
                or not (
                    parsed.scheme == "https"
                    or (
                        parsed.scheme == "http"
                        and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
                    )
                )
            ):
                raise ExternalServerConfigError(f"{name}：远程地址必须是 HTTPS，本机地址允许 HTTP")
            headers = item.get("headers") or {}
            if (
                not isinstance(headers, dict)
                or len(headers) > 20
                or any(
                    not isinstance(key, str)
                    or not HEADER_NAME.fullmatch(key)
                    or not isinstance(value, str)
                    or len(value) > 4000
                    or any(char in value for char in "\r\n\0")
                    for key, value in headers.items()
                )
            ):
                raise ExternalServerConfigError(f"{name}：请求头格式不正确")
            reserved = sorted(key for key in headers if key.casefold() in RESERVED_HEADERS)
            if reserved:
                raise ExternalServerConfigError(f"{name}：请求头 {reserved[0]} 由程序自动设置")
            server.update(url=url, headers=dict(headers))
        else:
            raise ExternalServerConfigError(f"{name}：类型只能是 stdio 或 http")
        servers.append(server)
    return servers


@asynccontextmanager
async def http_transport(url: str, headers: dict[str, str]) -> AsyncIterator[Any]:
    """带请求头的 Streamable HTTP 连接。

    不跟随重定向：自定义请求头（如 X-API-Key）会被原样带到跳转后的地址，令牌可能泄露给别的站点。
    """
    async with create_mcp_http_client(headers=headers) as client:
        client.follow_redirects = False
        async with streamable_http_client(url, http_client=client) as streams:
            yield streams


def build_servers(configs: list[dict[str, Any]], cwd: Path) -> list[ExternalServer]:
    """只连接启用的服务；stdio 命令在工作区目录下运行。"""
    servers = []
    for config in configs:
        if not config.get("enabled", True):
            continue
        if config["type"] == "stdio":
            transport: Any = StdioServerParameters(
                command=config["command"],
                args=config.get("args", []),
                env=config.get("env") or None,
                cwd=cwd,
            )
        elif config.get("headers"):
            transport = http_transport(config["url"], config["headers"])
        else:
            transport = config["url"]
        servers.append(ExternalServer(config["name"], transport, config.get("auto_approve", False)))
    return servers


def _public_name(server: str, tool: str, taken: set[str]) -> str:
    base = f"{PREFIX}{server}__{re.sub(r'[^A-Za-z0-9_-]', '_', tool)}"[:64]
    name, index = base, 2
    while name in taken:
        suffix = f"_{index}"
        name, index = base[: 64 - len(suffix)] + suffix, index + 1
    return name


class ExternalMcpTools:
    def __init__(
        self,
        servers: list[ExternalServer],
        *,
        connect_timeout: float = 30.0,
        call_timeout: float = 120.0,
    ) -> None:
        self.servers = servers
        self.connect_timeout = connect_timeout
        self.call_timeout = call_timeout
        self.connected: list[dict[str, Any]] = []
        self.failed: list[dict[str, str]] = []
        self._stack = AsyncExitStack()
        self._tools: list[dict[str, object]] = []
        # 对外名字 -> (服务, 提供者, 原工具名)
        self._routes: dict[str, tuple[ExternalServer, MCPToolProvider, str]] = {}

    async def __aenter__(self) -> Self:
        for server in self.servers:
            provider = MCPToolProvider(server.transport, read_timeout_seconds=self.call_timeout)
            try:
                async with asyncio.timeout(self.connect_timeout):
                    await self._stack.enter_async_context(provider)
                    tools = await provider.model_tools()
            except Exception as exc:
                self.failed.append(
                    {"name": server.name, "error": f"{type(exc).__name__}: {exc}"[:500]}
                )
                continue
            for tool in tools:
                original = str(tool["name"])
                public = _public_name(server.name, original, set(self._routes))
                self._routes[public] = (server, provider, original)
                self._tools.append(
                    {
                        **tool,
                        "name": public,
                        "description": f"[外部工具 {server.name}] {tool.get('description', '')}"[
                            :1024
                        ],
                    }
                )
            self.connected.append({"name": server.name, "tools": len(tools)})
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self._stack.aclose()

    def model_tools(self) -> list[dict[str, object]]:
        return list(self._tools)

    def server_for(self, tool_name: str) -> ExternalServer | None:
        route = self._routes.get(tool_name)
        return route[0] if route else None

    def original_name(self, tool_name: str) -> str:
        return self._routes[tool_name][2]

    async def call(self, tool_name: str, tool_call_id: str, raw_arguments: str) -> ToolResult:
        _server, provider, original = self._routes[tool_name]
        result = await provider.call_tool(original, tool_call_id, raw_arguments)
        return result.model_copy(update={"tool_name": tool_name})
