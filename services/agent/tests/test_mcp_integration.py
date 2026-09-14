"""Bit Agent MCP Server、Client Provider 与 Agent 运行时集成测试。"""

import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bit_agent.agent.result import AgentRunStatus
from bit_agent.agent.runtime import run_agent
from bit_agent.mcp_server import create_mcp_server
from bit_agent.sandbox import DEFAULT_IMAGE
from bit_agent.tool_provider import MCPToolProvider
from bit_agent.tools.models import ToolResult, ToolStatus
from mcp import Client, StdioServerParameters
from mcp.server import MCPServer


def docker_image_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        completed = subprocess.run(
            ["docker", "image", "inspect", DEFAULT_IMAGE],
            check=False,
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


DOCKER_IMAGE_READY = docker_image_ready()


def function_call(name: str, call_id: str, arguments: dict[str, object]) -> SimpleNamespace:
    return SimpleNamespace(
        type="function_call",
        name=name,
        call_id=call_id,
        arguments=json.dumps(arguments),
    )


def response(*items: SimpleNamespace, text: str = "") -> SimpleNamespace:
    return SimpleNamespace(output=list(items), output_text=text)


class FakeResponses:
    def __init__(self, responses: list[SimpleNamespace]) -> None:
        self._responses = iter(responses)
        self.requests: list[dict[str, object]] = []

    def create(self, **request: object) -> SimpleNamespace:
        self.requests.append(request)
        return next(self._responses)


class FakeClient:
    def __init__(self, responses: list[SimpleNamespace]) -> None:
        self.responses = FakeResponses(responses)


@pytest.mark.asyncio
async def test_mcp_server_lists_tools_and_binds_workspace(tmp_path: Path) -> None:
    (tmp_path / "example.py").write_text("value = 42\n", encoding="utf-8")
    server = create_mcp_server(tmp_path)

    async with Client(server, raise_exceptions=True) as client:
        listed = await client.list_tools()
        assert [tool.name for tool in listed.tools] == [
            "list_files",
            "read_file",
            "search_code",
            "run_tests",
            "run_checks",
            "apply_patch",
        ]
        assert all(
            "workspace_root" not in tool.input_schema.get("properties", {})
            for tool in listed.tools
        )

        response_result = await client.call_tool(
            "read_file",
            {"path": "example.py"},
        )

    assert response_result.is_error is False
    result = ToolResult.model_validate(response_result.structured_content)
    assert result.status is ToolStatus.SUCCESS
    assert result.output == "     1 | value = 42"
    assert result.metadata.affected_paths == ["example.py"]


@pytest.mark.asyncio
async def test_mcp_server_keeps_path_security(tmp_path: Path) -> None:
    server = create_mcp_server(tmp_path)

    async with Client(server, raise_exceptions=True) as client:
        response_result = await client.call_tool(
            "read_file",
            {"path": "../outside.txt"},
        )

    result = ToolResult.model_validate(response_result.structured_content)
    assert result.status is ToolStatus.REJECTED
    assert result.error is not None
    assert result.error.code == "PATH_OUTSIDE_WORKSPACE"


@pytest.mark.asyncio
async def test_mcp_provider_discovers_and_calls_bit_agent_tools(tmp_path: Path) -> None:
    (tmp_path / "example.py").write_text("value = 42\n", encoding="utf-8")
    provider = MCPToolProvider(create_mcp_server(tmp_path), raise_exceptions=True)

    async with provider:
        tools = await provider.model_tools()
        result = await provider.call_tool(
            "read_file",
            "model-call-1",
            json.dumps({"path": "example.py"}),
        )

    assert [tool["name"] for tool in tools] == [
        "list_files",
        "read_file",
        "search_code",
        "run_tests",
        "run_checks",
        "apply_patch",
    ]
    assert all(tool["strict"] is True for tool in tools)
    assert result.tool_call_id == "model-call-1"
    assert result.status is ToolStatus.SUCCESS
    assert result.output == "     1 | value = 42"


@pytest.mark.asyncio
async def test_mcp_provider_can_consume_third_party_tool_results() -> None:
    third_party_server = MCPServer("third-party")

    @third_party_server.tool()
    def add(left: int, right: int) -> int:
        """返回两个整数之和。"""
        return left + right

    async with MCPToolProvider(third_party_server, raise_exceptions=True) as provider:
        tools = await provider.model_tools()
        result = await provider.call_tool(
            "add",
            "third-party-call-1",
            json.dumps({"left": 7, "right": 5}),
        )

    assert [tool["name"] for tool in tools] == ["add"]
    assert result.status is ToolStatus.SUCCESS
    assert result.output == {"result": 12}


@pytest.mark.asyncio
async def test_agent_runtime_can_use_mcp_provider(tmp_path: Path) -> None:
    (tmp_path / "example.py").write_text("value = 42\n", encoding="utf-8")
    model_client = FakeClient(
        [
            response(function_call("read_file", "read-1", {"path": "example.py"})),
            response(SimpleNamespace(type="message"), text="文件内容已经读取"),
        ]
    )

    result = await run_agent(
        "读取 example.py",
        workspace_root=tmp_path,
        response_client=model_client,
        model_name="test-model",
        tool_provider=MCPToolProvider(create_mcp_server(tmp_path), raise_exceptions=True),
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert result.final_answer == "文件内容已经读取"
    assert [record.tool_name for record in result.tool_calls] == ["read_file"]
    first_request = model_client.responses.requests[0]
    request_tools = first_request["tools"]
    assert isinstance(request_tools, list)
    assert {tool["name"] for tool in request_tools} == {
        "list_files",
        "read_file",
        "search_code",
        "run_tests",
        "run_checks",
        "apply_patch",
    }


@pytest.mark.asyncio
async def test_stdio_mcp_transport_is_real_protocol_boundary(tmp_path: Path) -> None:
    (tmp_path / "stdio.txt").write_text("hello from stdio\n", encoding="utf-8")
    server = StdioServerParameters(
        command=sys.executable,
        args=[
            "-m",
            "bit_agent.mcp_server",
            "--workspace",
            str(tmp_path),
        ],
    )

    async with MCPToolProvider(server) as provider:
        tools = await provider.model_tools()
        result = await provider.call_tool(
            "read_file",
            "stdio-call-1",
            json.dumps({"path": "stdio.txt"}),
        )

    assert {tool["name"] for tool in tools} == {
        "list_files",
        "read_file",
        "search_code",
        "run_tests",
        "run_checks",
        "apply_patch",
    }
    assert result.status is ToolStatus.SUCCESS
    assert result.output == "     1 | hello from stdio"


@pytest.mark.skipif(not DOCKER_IMAGE_READY, reason="Docker 或 Bit Agent 沙箱镜像不可用")
@pytest.mark.asyncio
async def test_mcp_can_patch_and_verify_in_docker(tmp_path: Path) -> None:
    calculator = tmp_path / "calculator.py"
    calculator.write_text(
        "def add(left: int, right: int) -> int:\n    return left - right\n",
        encoding="utf-8",
    )
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_calculator.py").write_text(
        "from calculator import add\n\ndef test_add() -> None:\n    assert add(7, 5) == 12\n",
        encoding="utf-8",
    )
    patch = (
        "*** Begin Patch\n"
        "*** Update File: calculator.py\n"
        "@@\n"
        " def add(left: int, right: int) -> int:\n"
        "-    return left - right\n"
        "+    return left + right\n"
        "*** End Patch\n"
    )

    async with MCPToolProvider(create_mcp_server(tmp_path), raise_exceptions=True) as provider:
        patch_result = await provider.call_tool(
            "apply_patch",
            "mcp-patch-1",
            json.dumps({"patch": patch}),
        )
        test_result = await provider.call_tool(
            "run_tests",
            "mcp-test-1",
            json.dumps({"target": "tests"}),
        )
        lint_result = await provider.call_tool(
            "run_checks",
            "mcp-lint-1",
            json.dumps({"check": "lint", "paths": ["calculator.py"]}),
        )

    assert patch_result.status is ToolStatus.SUCCESS
    assert patch_result.metadata.affected_paths == ["calculator.py"]
    assert calculator.read_text(encoding="utf-8").endswith("return left + right\n")
    assert test_result.status is ToolStatus.SUCCESS
    assert isinstance(test_result.output, dict)
    assert test_result.output["exit_code"] == 0
    assert "1 passed" in str(test_result.output["stdout"])
    assert lint_result.status is ToolStatus.SUCCESS
