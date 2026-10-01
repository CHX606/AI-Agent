"""外部 MCP 工具：配置校验、连接、命名、权限确认和桌面任务中的使用。"""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application import service as service_module
from bit_agent.runtime.application.delegation import DelegatingToolProvider
from bit_agent.runtime.application.interaction import TaskInteraction
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.domain.errors import InteractionError
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.storage import LocalStorage
from bit_agent.runtime.infrastructure.verification import verify_project
from bit_agent.tool_provider.external import (
    ExternalMcpTools,
    ExternalServer,
    ExternalServerConfigError,
    validate_servers,
)
from bit_agent.tools.models import ToolStatus
from mcp.server import MCPServer


def demo_server() -> MCPServer:
    server = MCPServer("demo")

    @server.tool(name="echo", description="原样返回文字")
    async def echo(text: str) -> str:
        return f"echo:{text}"

    @server.tool(name="dotted.name", description="名字里有点号")
    async def dotted() -> str:
        return "ok"

    return server


def test_validate_servers():
    config = validate_servers(
        [
            {
                "name": "files",
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "x"],
                "env": {"TOKEN": "secret"},
            },
            {
                "name": "docs",
                "type": "http",
                "url": "https://mcp.example.com/mcp",
                "enabled": False,
                "auto_approve": True,
            },
        ]
    )
    assert config[0] == {
        "name": "files",
        "type": "stdio",
        "enabled": True,
        "auto_approve": False,
        "command": "npx",
        "args": ["-y", "x"],
        "env": {"TOKEN": "secret"},
    }
    assert config[1]["enabled"] is False and config[1]["auto_approve"] is True


@pytest.mark.parametrize(
    "server",
    [
        {"name": "bad name", "type": "stdio", "command": "x"},
        {"name": "a", "type": "stdio", "command": " "},
        {"name": "a", "type": "stdio", "command": "x", "env": {"1BAD": "v"}},
        {"name": "a", "type": "http", "url": "http://example.com/mcp"},
        {"name": "a", "type": "http", "url": "https://user:pw@example.com/mcp"},
        {"name": "a", "type": "ftp"},
        {"name": "a", "type": "stdio", "command": "x", "shell": True},
    ],
)
def test_invalid_servers_are_rejected(server):
    with pytest.raises(ExternalServerConfigError):
        validate_servers([server])


def test_duplicate_names_are_rejected():
    with pytest.raises(ExternalServerConfigError, match="重复"):
        validate_servers(
            [
                {"name": "A", "type": "http", "url": "https://x.test"},
                {"name": "a", "type": "http", "url": "https://y.test"},
            ]
        )


async def test_tools_are_prefixed_and_unreachable_servers_are_reported():
    tools = ExternalMcpTools(
        [
            ExternalServer("demo", demo_server()),
            ExternalServer("down", "http://127.0.0.1:9/mcp"),
        ],
        connect_timeout=10,
    )
    async with tools:
        names = [tool["name"] for tool in tools.model_tools()]
        assert names == ["mcp__demo__echo", "mcp__demo__dotted_name"]
        assert tools.model_tools()[0]["description"].startswith("[外部工具 demo]")
        assert tools.connected == [{"name": "demo", "tools": 2}]
        assert [item["name"] for item in tools.failed] == ["down"]
        result = await tools.call("mcp__demo__echo", "c1", json.dumps({"text": "你好"}))
        assert result.status is ToolStatus.SUCCESS
        assert result.tool_name == "mcp__demo__echo" and result.output == {"result": "echo:你好"}
        assert tools.original_name("mcp__demo__dotted_name") == "dotted.name"


async def control(tmp_path: Path) -> TaskInteraction:
    storage = LocalStorage(tmp_path / "data")
    await storage.call(
        "create",
        {
            "task_id": "task",
            "session_id": "s",
            "multi_agent_mode": "off",
            "objective": "t",
            "workspace_root": str(tmp_path),
            "status": "RUNNING",
            "created_at": "2026-10-01T00:00:00Z",
            "updated_at": "2026-10-01T00:00:00Z",
            "started_at": None,
            "completed_at": None,
            "worker_id": "local",
            "run_id": None,
            "result": None,
            "error": None,
        },
    )
    return TaskInteraction(storage, "task")


def provider(tmp_path, mode, interaction=None, auto_approve=False):
    return DelegatingToolProvider(
        tmp_path,
        "off",
        InMemoryEventSink(),
        tmp_path / "artifacts",
        interaction,
        permission_mode=mode,
        journal=ChangeJournal(tmp_path, tmp_path / "artifacts"),
        verifier=verify_project,
        external=ExternalMcpTools([ExternalServer("demo", demo_server(), auto_approve)]),
    )


async def test_read_only_mode_hides_external_tools(tmp_path):
    async with provider(tmp_path, "read_only") as tools:
        assert not any(t["name"].startswith("mcp__") for t in await tools.model_tools())


async def test_confirm_mode_asks_and_can_approve_whole_server(tmp_path):
    interaction = await control(tmp_path)
    async with provider(tmp_path, "confirm", interaction) as tools:
        assert "mcp__demo__echo" in {t["name"] for t in await tools.model_tools()}
        pending = asyncio.create_task(
            tools.call_tool("mcp__demo__echo", "c1", json.dumps({"text": "a"}))
        )
        for _ in range(400):
            if interaction.question is not None:
                break
            await asyncio.sleep(0.005)
        question = interaction.question
        assert "调用外部工具 demo · echo" in question["question"]
        assert [option["id"] for option in question["options"]] == [
            "reject",
            "approve",
            "approve_task",
        ]
        await interaction.request(
            {"action": "answer", "question_id": question["id"], "option_id": "approve_task"}
        )
        assert (await pending).output == {"result": "echo:a"}
        # 同一服务本任务内不再询问。
        second = await tools.call_tool("mcp__demo__echo", "c2", json.dumps({"text": "b"}))
        assert second.output == {"result": "echo:b"}
    interaction.storage.close()


async def test_edit_mode_without_auto_approve_still_asks(tmp_path):
    async with provider(tmp_path, "edit") as tools:
        # 没有交互控制时无法询问，只能拒绝。
        result = await tools.call_tool("mcp__demo__echo", "c", json.dumps({"text": "x"}))
        assert result.error.code == "PERMISSION_DENIED"
    async with provider(tmp_path, "edit", auto_approve=True) as tools:
        result = await tools.call_tool("mcp__demo__echo", "c", json.dumps({"text": "x"}))
        assert result.output == {"result": "echo:x"}


async def test_desktop_task_uses_configured_server(tmp_path, monkeypatch):
    class Responses:
        def create(self, **request):
            names = {tool["name"] for tool in request["tools"]}
            assert "mcp__demo__echo" in names
            if any(item.get("type") == "function_call_output" for item in request["input"]):
                return SimpleNamespace(output=[], output_text="已调用")
            call = SimpleNamespace(
                type="function_call",
                call_id="ext",
                name="mcp__demo__echo",
                arguments=json.dumps({"text": "hi"}),
            )
            return SimpleNamespace(output=[call], output_text="")

    monkeypatch.setitem(
        sys.modules,
        "bit_agent.llm.client",
        SimpleNamespace(client=SimpleNamespace(responses=Responses()), model_name="fixture"),
    )
    # 配置里的 http 服务在测试中换成进程内服务。
    monkeypatch.setattr(
        service_module,
        "build_servers",
        lambda configs, cwd: [ExternalServer("demo", demo_server(), True)] if configs else [],
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        with pytest.raises(InteractionError):
            await runtime.configure_mcp([{"name": "bad name", "type": "http", "url": "https://x"}])
        assert await runtime.configure_mcp(
            [{"name": "demo", "type": "http", "url": "https://x.test/mcp", "auto_approve": True}]
        ) == {"configured": 1, "enabled": 1}
        task = await runtime.create_task(
            {
                "objective": "用外部工具",
                "workspace_root": str(workspace),
                "multi_agent_mode": "off",
                "permission_mode": "edit",
            }
        )
        await asyncio.wait_for(runtime._running[task["task_id"]], 15)
        stored = await runtime.get_task(task["task_id"])
        assert stored["status"] == "COMPLETED", stored
        calls = stored["result"]["tool_calls"]
        assert calls[0]["tool_name"] == "mcp__demo__echo" and calls[0]["output"] == {
            "result": "echo:hi"
        }
        events = await runtime.read_events(task["task_id"])
        loaded = [e for e in events if e["event_type"] == "EXTERNAL_TOOLS_LOADED"]
        assert loaded[0]["data"]["connected"] == [{"name": "demo", "tools": 2}]
    finally:
        await runtime.close()


async def test_connection_test_runs_a_real_stdio_server(tmp_path):
    from bit_agent.runtime.application.service import AgentRuntime

    result = await AgentRuntime.test_mcp(
        SimpleNamespace(),
        {
            "name": "self",
            "type": "stdio",
            "command": sys.executable,
            "args": ["-m", "bit_agent.mcp_server", "--workspace", str(tmp_path)],
        },
    )
    assert result["ok"], result
    assert "read_file" in result["tools"]
    failed = await AgentRuntime.test_mcp(
        SimpleNamespace(), {"name": "missing", "type": "stdio", "command": "no-such-command-xyz"}
    )
    assert not failed["ok"] and failed["message"]
