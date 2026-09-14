"""动态 Agent 运行时的工具循环与 Docker 验证测试。"""

import json
import shutil
import subprocess
from collections.abc import Iterable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from bit_agent.agent import runtime
from bit_agent.agent.result import AgentRunStatus
from bit_agent.context import (
    CONTEXT_SUMMARY_PREFIX,
    ContextManagementPolicy,
    ContextManager,
    DeterministicContextSummarizer,
    FileContextArtifactStore,
)
from bit_agent.memory import InMemoryWorkingMemoryStore
from bit_agent.sandbox import DEFAULT_IMAGE
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


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


class FakeResponses:
    def __init__(self, responses: Iterable[SimpleNamespace]) -> None:
        self._responses = iter(responses)
        self.requests: list[list[Any]] = []

    def create(self, *, model: str, input: list[Any], tools: list[dict[str, Any]]) -> Any:
        assert model == "test-model"
        assert tools == runtime.TOOL_SCHEMAS
        self.requests.append(list(input))
        return next(self._responses)


class FakeClient:
    def __init__(self, responses: Iterable[SimpleNamespace]) -> None:
        self.responses = FakeResponses(responses)


def function_call(
    name: str,
    call_id: str,
    arguments: str = "{}",
) -> SimpleNamespace:
    return SimpleNamespace(
        type="function_call",
        name=name,
        call_id=call_id,
        arguments=arguments,
    )


def response(*items: SimpleNamespace, text: str = "") -> SimpleNamespace:
    return SimpleNamespace(output=list(items), output_text=text)


def final_message(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="message", text=text)


def fake_tool_result(
    *,
    tool_call_id: str,
    tool_name: str,
    status: ToolStatus = ToolStatus.SUCCESS,
    affected_paths: list[str] | None = None,
) -> ToolResult:
    return ToolResult(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        status=status,
        output="ok" if status is ToolStatus.SUCCESS else None,
        error=None
        if status is ToolStatus.SUCCESS
        else ToolError(code="FAILED", message="失败", retryable=True),
        metadata=ToolMetadata(
            duration_ms=1,
            affected_paths=affected_paths or [],
        ),
    )


def test_read_file_schema_exposes_line_range_in_strict_mode() -> None:
    schema = next(tool for tool in runtime.TOOL_SCHEMAS if tool["name"] == "read_file")
    parameters = schema["parameters"]
    assert schema["strict"] is True
    assert parameters["additionalProperties"] is False
    assert set(parameters["properties"]) == {"path", "start_line", "end_line"}
    assert set(parameters["required"]) == set(parameters["properties"])
    assert parameters["properties"]["start_line"]["type"] == "integer"
    assert parameters["properties"]["start_line"]["minimum"] == 1
    assert parameters["properties"]["end_line"]["type"] == ["integer", "null"]


def test_search_schema_exposes_filters_in_strict_mode() -> None:
    schema = next(tool for tool in runtime.TOOL_SCHEMAS if tool["name"] == "search_code")
    parameters = schema["parameters"]
    assert schema["strict"] is True
    assert parameters["additionalProperties"] is False
    assert set(parameters["properties"]) == {"query", "path", "glob", "max_results"}
    assert set(parameters["required"]) == set(parameters["properties"])
    assert parameters["properties"]["glob"]["type"] == ["string", "null"]
    assert parameters["properties"]["max_results"]["minimum"] == 1
    assert parameters["properties"]["max_results"]["maximum"] == 200


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep 不可用")
async def test_model_receives_search_hint_and_can_narrow_results(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("needle_one\nneedle_two\nneedle_three\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("needle_excluded\n", encoding="utf-8")
    client = FakeClient([
        response(function_call("search_code", "broad", json.dumps({
            "query": "needle", "path": "", "glob": None, "max_results": 1,
        }))),
        response(function_call("search_code", "narrow", json.dumps({
            "query": "needle", "path": "", "glob": "*.py", "max_results": 50,
        }))),
        response(final_message("已定位代码"), text="已定位代码"),
    ])
    result = await runtime.run_agent(
        "查找 needle", workspace_root=tmp_path,
        response_client=client, model_name="test-model",
    )
    assert result.status is AgentRunStatus.COMPLETED
    assert len(result.tool_calls) == 2
    first, second = result.tool_calls
    assert first.error and first.error.code == "RESULT_LIMIT_EXCEEDED"
    assert second.status is ToolStatus.SUCCESS
    assert len(second.output.splitlines()) == 3
    assert "notes.txt" not in second.output
    returned = next(
        item for item in client.responses.requests[1]
        if isinstance(item, dict) and item.get("type") == "function_call_output"
        and item["call_id"] == "broad"
    )
    payload = json.loads(returned["output"])
    assert payload["output"]
    assert payload["metadata"]["truncated"] is True
    assert "搜索结果不完整" in payload["error"]["message"]
    assert "query" in payload["error"]["message"]
    assert "原样重复搜索不会自动返回下一批" in payload["error"]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("end_line,expected_end", [(802, 802), (None, 1299)])
async def test_model_can_read_beyond_first_500_lines(
    tmp_path: Path, end_line: int | None, expected_end: int
) -> None:
    (tmp_path / "large.py").write_text(
        "".join(f"v{number}\n" for number in range(1, 1401)),
        encoding="utf-8",
    )
    client = FakeClient([
        response(function_call("read_file", "range-read", json.dumps({
            "path": "large.py", "start_line": 800, "end_line": end_line,
        }))),
        response(final_message("已读取指定范围"), text="已读取指定范围"),
    ])

    result = await runtime.run_agent(
        "读取 large.py 第 800 行附近的代码",
        workspace_root=tmp_path, response_client=client, model_name="test-model",
    )

    expected = "\n".join(
        f"{number:>6} | v{number}"
        for number in range(800, expected_end + 1)
    )
    assert result.status is AgentRunStatus.COMPLETED
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].status is ToolStatus.SUCCESS
    assert result.tool_calls[0].output == expected
    returned = next(
        item for item in client.responses.requests[-1]
        if isinstance(item, dict) and item.get("type") == "function_call_output"
        and item["call_id"] == "range-read"
    )
    assert json.loads(returned["output"])["output"] == expected


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep 不可用")
async def test_search_result_line_can_be_read_by_model(tmp_path: Path) -> None:
    (tmp_path / "large.py").write_text(
        "\n" * 799 + "def target_login():\n    return True\n", encoding="utf-8"
    )
    client = FakeClient([
        response(function_call("search_code", "locate", json.dumps({
            "query": "target_login", "path": "large.py",
        }))),
        response(function_call("read_file", "read-match", json.dumps({
            "path": "large.py", "start_line": 800, "end_line": 801,
        }))),
        response(final_message("已找到登录实现"), text="已找到登录实现"),
    ])
    result = await runtime.run_agent(
        "找到并读取登录实现", workspace_root=tmp_path,
        response_client=client, model_name="test-model",
    )
    assert result.status is AgentRunStatus.COMPLETED
    assert [record.tool_name for record in result.tool_calls] == ["search_code", "read_file"]
    assert all(record.status is ToolStatus.SUCCESS for record in result.tool_calls)
    assert "800:5:def target_login():" in result.tool_calls[0].output
    assert result.tool_calls[1].output == "   800 | def target_login():\n   801 |     return True"


@pytest.mark.asyncio
async def test_returns_structured_agent_run_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_execute_tool(
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
        workspace_root: Path,
    ) -> ToolResult:
        affected_paths = ["calculator.py"] if tool_name == "apply_patch" else ["tests"]
        return fake_tool_result(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            affected_paths=affected_paths,
        )

    monkeypatch.setattr(runtime, "execute_tool", fake_execute_tool)
    client = FakeClient(
        [
            response(
                function_call(
                    "apply_patch",
                    "patch_1",
                    json.dumps({"patch": "example"}),
                )
            ),
            response(
                function_call(
                    "run_tests",
                    "test_1",
                    json.dumps({"target": "tests"}),
                )
            ),
            response(
                function_call(
                    "run_checks",
                    "lint_1",
                    json.dumps({"check": "lint", "paths": ["calculator.py"]}),
                )
            ),
            response(final_message("修复完成"), text="修复完成"),
        ]
    )

    result = await runtime.run_agent(
        "修复错误",
        workspace_root=tmp_path,
        response_client=client,
        model_name="test-model",
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert result.final_answer == "修复完成"
    assert result.rounds == 3
    assert result.changed_files == ["calculator.py"]
    assert result.tests_passed is True
    assert result.quality_checks_passed is True
    assert result.thread_id is not None
    assert result.run_id is not None
    assert result.working_memory is not None
    assert result.working_memory.changed_files == ["calculator.py"]
    assert result.working_memory.latest_test_status.value == "PASSED"
    assert [record.tool_name for record in result.tool_calls] == [
        "apply_patch",
        "run_tests",
        "run_checks",
    ]
    assert result.tool_calls[0].arguments == {"patch": "example"}
    assert result.tool_calls[0].metadata.affected_paths == ["calculator.py"]


@pytest.mark.asyncio
async def test_structured_result_preserves_trace_when_run_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_execute_tool(
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
        workspace_root: Path,
    ) -> ToolResult:
        return fake_tool_result(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            affected_paths=["calculator.py"],
        )

    monkeypatch.setattr(runtime, "execute_tool", fake_execute_tool)
    client = FakeClient(
        [
            response(function_call("apply_patch", "patch_1")),
            response(final_message("提前结束"), text="提前结束"),
        ]
    )

    result = await runtime.run_agent(
        "修复错误",
        workspace_root=tmp_path,
        max_tool_rounds=1,
        response_client=client,
        model_name="test-model",
    )

    assert result.status is AgentRunStatus.FAILED
    assert result.final_answer is None
    assert result.rounds == 1
    assert result.changed_files == ["calculator.py"]
    assert result.tests_passed is False
    assert len(result.tool_calls) == 1
    assert result.error is not None and "未完成验证" in result.error


@pytest.mark.asyncio
async def test_rejects_final_answer_until_tests_pass(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def fake_execute_tool(
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
        workspace_root: Path,
    ) -> ToolResult:
        calls.append(tool_name)
        return fake_tool_result(tool_call_id=tool_call_id, tool_name=tool_name)

    monkeypatch.setattr(runtime, "execute_tool", fake_execute_tool)
    client = FakeClient(
        [
            response(function_call("apply_patch", "patch_1")),
            response(final_message("未经验证就结束"), text="未经验证就结束"),
            response(function_call("run_tests", "test_1")),
            response(final_message("只通过测试就结束"), text="只通过测试就结束"),
            response(
                function_call(
                    "run_checks",
                    "lint_1",
                    '{"check":"lint","paths":["calculator.py"]}',
                )
            ),
            response(final_message("已验证"), text="已验证"),
        ]
    )

    result = await runtime.run_agent(
        "修复错误",
        workspace_root=tmp_path,
        response_client=client,
        model_name="test-model",
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert result.final_answer == "已验证"
    assert result.tests_passed is True
    assert result.quality_checks_passed is True
    assert calls == ["apply_patch", "run_tests", "run_checks"]
    third_request = client.responses.requests[2]
    assert any(
        isinstance(item, dict) and item.get("content") == runtime.VERIFICATION_REQUIRED_MESSAGE
        for item in third_request
    )


@pytest.mark.asyncio
async def test_failed_tests_do_not_clear_verification_requirement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_results = iter([ToolStatus.ERROR, ToolStatus.SUCCESS])
    calls: list[str] = []

    async def fake_execute_tool(
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
        workspace_root: Path,
    ) -> ToolResult:
        calls.append(tool_name)
        if tool_name == "run_tests":
            return fake_tool_result(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                status=next(test_results),
            )
        return fake_tool_result(tool_call_id=tool_call_id, tool_name=tool_name)

    monkeypatch.setattr(runtime, "execute_tool", fake_execute_tool)
    client = FakeClient(
        [
            response(function_call("apply_patch", "patch_1")),
            response(function_call("run_tests", "test_1")),
            response(final_message("测试失败后提前结束"), text="提前结束"),
            response(function_call("run_tests", "test_2")),
            response(final_message("只通过测试后提前结束"), text="仍提前结束"),
            response(
                function_call(
                    "run_checks",
                    "lint_1",
                    '{"check":"lint","paths":["calculator.py"]}',
                )
            ),
            response(final_message("重试通过"), text="重试通过"),
        ]
    )

    result = await runtime.run_agent(
        "修复错误",
        workspace_root=tmp_path,
        response_client=client,
        model_name="test-model",
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert result.final_answer == "重试通过"
    assert result.tests_passed is True
    assert result.quality_checks_passed is True
    assert calls == ["apply_patch", "run_tests", "run_tests", "run_checks"]
    assert len(client.responses.requests) == 7


@pytest.mark.asyncio
async def test_lint_must_cover_every_changed_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def fake_execute_tool(
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
        workspace_root: Path,
    ) -> ToolResult:
        del raw_arguments, workspace_root
        calls.append(tool_name)
        return fake_tool_result(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            affected_paths=["calculator.py"] if tool_name == "apply_patch" else [],
        )

    monkeypatch.setattr(runtime, "execute_tool", fake_execute_tool)
    client = FakeClient(
        [
            response(function_call("apply_patch", "patch_1")),
            response(function_call("run_tests", "test_1")),
            response(
                function_call(
                    "run_checks",
                    "lint_1",
                    '{"check":"lint","paths":["other.py"]}',
                )
            ),
            response(final_message("范围不完整"), text="范围不完整"),
            response(
                function_call(
                    "run_checks",
                    "lint_2",
                    '{"check":"lint","paths":["calculator.py"]}',
                )
            ),
            response(final_message("完整验证"), text="完整验证"),
        ]
    )

    result = await runtime.run_agent(
        "修复错误",
        workspace_root=tmp_path,
        response_client=client,
        model_name="test-model",
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert result.quality_checks_passed is True
    assert calls == ["apply_patch", "run_tests", "run_checks", "run_checks"]


@pytest.mark.asyncio
async def test_allows_final_answer_when_no_code_was_modified(tmp_path: Path) -> None:
    client = FakeClient([response(final_message("无需修改"), text="无需修改")])

    result = await runtime.run_agent(
        "解释代码",
        workspace_root=tmp_path,
        response_client=client,
        model_name="test-model",
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert result.final_answer == "无需修改"
    assert result.tests_passed is False
    assert len(client.responses.requests) == 1


@pytest.mark.asyncio
async def test_verified_long_term_memory_is_injected_with_a_trust_boundary(
    tmp_path: Path,
) -> None:
    class FakeRetriever:
        async def build_context(self, query: str, **kwargs: object) -> SimpleNamespace:
            assert query == "继续排查"
            assert kwargs == {"project_id": "bit_agent", "user_id": None}
            return SimpleNamespace(
                text="[Memory project.testing.rule]\n内容：修改后运行测试",
                matches=[SimpleNamespace(memory=SimpleNamespace(id="memory-1"))],
                estimated_tokens=17,
            )

    client = FakeClient([response(final_message("完成"), text="完成")])
    result = await runtime.run_agent(
        "继续排查",
        workspace_root=tmp_path,
        response_client=client,
        model_name="test-model",
        memory_retriever=FakeRetriever(),  # type: ignore[arg-type]
        memory_project_id="bit_agent",
    )

    request = client.responses.requests[0]
    assert request[0]["role"] == "developer"
    assert runtime.LONG_TERM_MEMORY_PREFIX in request[0]["content"]
    assert request[1] == {"role": "user", "content": "继续排查"}
    assert result.recalled_memory_ids == ["memory-1"]
    assert result.memory_context_tokens == 17


@pytest.mark.asyncio
async def test_working_memory_can_be_restored_by_thread_id(tmp_path: Path) -> None:
    store = InMemoryWorkingMemoryStore()
    first = await runtime.run_agent(
        "调查第一次任务",
        workspace_root=tmp_path,
        response_client=FakeClient([response(final_message("暂停"), text="暂停")]),
        model_name="test-model",
        thread_id="shared-thread",
        working_memory_store=store,
    )
    assert first.working_memory is not None

    saved = await store.load("shared-thread")
    assert saved is not None
    saved.important_findings = ["已经确认入口位于 app.py"]
    await store.save(saved)

    resumed = await runtime.run_agent(
        "继续之前的任务",
        workspace_root=tmp_path,
        response_client=FakeClient([response(final_message("继续完成"), text="继续完成")]),
        model_name="test-model",
        thread_id="shared-thread",
        working_memory_store=store,
    )

    assert resumed.working_memory is not None
    assert resumed.working_memory.objective == "调查第一次任务"
    assert resumed.working_memory.important_findings == ["已经确认入口位于 app.py"]


@pytest.mark.asyncio
async def test_stops_when_model_repeatedly_avoids_required_tests(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_execute_tool(
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
        workspace_root: Path,
    ) -> ToolResult:
        return fake_tool_result(tool_call_id=tool_call_id, tool_name=tool_name)

    monkeypatch.setattr(runtime, "execute_tool", fake_execute_tool)
    client = FakeClient(
        [
            response(function_call("apply_patch", "patch_1")),
            response(final_message("第一次提前结束"), text="第一次提前结束"),
            response(final_message("第二次提前结束"), text="第二次提前结束"),
        ]
    )

    result = await runtime.run_agent(
        "修复错误",
        workspace_root=tmp_path,
        max_tool_rounds=2,
        response_client=client,
        model_name="test-model",
    )

    assert result.status is AgentRunStatus.FAILED
    assert result.error is not None and "未完成验证" in result.error
    assert result.tests_passed is False


@pytest.mark.skipif(not DOCKER_IMAGE_READY, reason="Docker 或 Bit Agent 沙箱镜像不可用")
@pytest.mark.asyncio
async def test_real_tools_require_successful_docker_test_before_finishing(
    tmp_path: Path,
) -> None:
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
    client = FakeClient(
        [
            response(
                function_call(
                    "apply_patch",
                    "patch_1",
                    json.dumps({"patch": patch}),
                )
            ),
            response(final_message("修改后提前结束"), text="修改后提前结束"),
            response(
                function_call(
                    "run_tests",
                    "test_1",
                    json.dumps({"target": "tests"}),
                )
            ),
            response(
                function_call(
                    "run_checks",
                    "lint_1",
                    json.dumps({"check": "lint", "paths": ["calculator.py"]}),
                )
            ),
            response(final_message("Docker 验证通过"), text="Docker 验证通过"),
        ]
    )

    result = await runtime.run_agent(
        "修复加法错误",
        workspace_root=tmp_path,
        response_client=client,
        model_name="test-model",
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert result.final_answer == "Docker 验证通过"
    assert result.tests_passed is True
    assert result.quality_checks_passed is True
    assert calculator.read_text(encoding="utf-8").endswith("return left + right\n")


@pytest.mark.asyncio
async def test_runtime_compacts_history_and_reports_context_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def verbose_execute_tool(
        tool_name: str,
        tool_call_id: str,
        raw_arguments: str,
        workspace_root: Path,
    ) -> ToolResult:
        del raw_arguments, workspace_root
        return ToolResult(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            status=ToolStatus.SUCCESS,
            output="tool evidence " + ("x" * 5_000),
            metadata=ToolMetadata(duration_ms=1),
        )

    monkeypatch.setattr(runtime, "execute_tool", verbose_execute_tool)
    context_manager = ContextManager(
        policy=ContextManagementPolicy(
            # 工具 schema 也计入预算；为新增行号参数留空间，仍保持低软阈值触发压缩。
            context_window_tokens=4_000,
            reserved_output_tokens=200,
            target_ratio=0.30,
            soft_limit_ratio=0.45,
            hard_limit_ratio=0.90,
            keep_recent_groups=1,
            minimum_recent_groups=1,
            tool_output_artifact_tokens=100,
            inline_tool_output_tokens=40,
            summarization_input_tokens=800,
            summary_tokens=250,
        ),
        summarizer=DeterministicContextSummarizer(),
        artifact_store=FileContextArtifactStore(tmp_path / "context-artifacts"),
    )
    client = FakeClient(
        [
            response(function_call("read_file", "read-1", '{"path":"a.py"}')),
            response(function_call("search_code", "search-1", '{"query":"x","path":""}')),
            response(final_message("调查完成"), text="调查完成"),
        ]
    )

    result = await runtime.run_agent(
        "调查代码问题",
        workspace_root=tmp_path,
        response_client=client,
        model_name="test-model",
        context_manager=context_manager,
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert result.context_compactions >= 1
    assert len(result.context_artifact_paths) == 2
    assert all(Path(path).is_file() for path in result.context_artifact_paths)
    assert result.working_memory is not None
    assert "history_summary" not in result.working_memory.model_dump()
    assert context_manager.summary is not None
    assert any(
        isinstance(item, dict)
        and isinstance(item.get("content"), str)
        and item["content"].startswith(CONTEXT_SUMMARY_PREFIX)
        for item in client.responses.requests[-1]
    )
