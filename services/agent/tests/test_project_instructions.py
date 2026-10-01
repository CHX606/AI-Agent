"""项目说明文件：读取、截断，以及在桌面任务里交给主 Agent。"""

import asyncio
import sys
from types import SimpleNamespace

from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.infrastructure import project_instructions
from bit_agent.runtime.infrastructure.project_instructions import read_project_instructions


def test_no_instruction_files(tmp_path):
    assert read_project_instructions(tmp_path) is None
    (tmp_path / "AGENTS.md").write_text("   \n")
    assert read_project_instructions(tmp_path) is None


def test_reads_both_files_in_order(tmp_path):
    (tmp_path / "AGENTS.md").write_text("用 pnpm，不要用 npm。", encoding="utf-8")
    (tmp_path / ".bit-agent").mkdir()
    (tmp_path / ".bit-agent" / "instructions.md").write_text(
        "测试命令是 make test", encoding="utf-8"
    )
    result = read_project_instructions(tmp_path)
    assert result["paths"] == ["AGENTS.md", ".bit-agent/instructions.md"]
    assert result["text"].index("pnpm") < result["text"].index("make test")
    assert not result["truncated"]


def test_long_instructions_are_truncated(tmp_path, monkeypatch):
    monkeypatch.setattr(project_instructions, "MAX_TOTAL_BYTES", 10)
    (tmp_path / "AGENTS.md").write_text("a" * 50)
    (tmp_path / ".bit-agent").mkdir()
    (tmp_path / ".bit-agent" / "instructions.md").write_text("b")
    result = read_project_instructions(tmp_path)
    assert result["text"].endswith("a" * 10)
    assert result["paths"] == ["AGENTS.md"]
    assert result["truncated"]


async def test_desktop_task_passes_instructions_to_main_agent(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "AGENTS.md").write_text(
        "PROJECT-RULE-CANARY：提交前运行 make lint", encoding="utf-8"
    )
    seen = []

    class Responses:
        def create(self, **request):
            seen.append(request["input"])
            return SimpleNamespace(output=[], output_text="好的")

    monkeypatch.setitem(
        sys.modules,
        "bit_agent.llm.client",
        SimpleNamespace(client=SimpleNamespace(responses=Responses()), model_name="fixture"),
    )
    runtime = create_runtime(tmp_path / "data")
    await runtime.start()
    try:
        task = await runtime.create_task(
            {"objective": "你好", "workspace_root": str(workspace), "multi_agent_mode": "off"}
        )
        await asyncio.wait_for(runtime._running[task["task_id"]], 10)
        assert (await runtime.get_task(task["task_id"]))["status"] == "COMPLETED"
        developer = [item for item in seen[0] if item.get("role") == "developer"]
        assert any("PROJECT-RULE-CANARY" in str(item["content"]) for item in developer)
        events = await runtime.read_events(task["task_id"])
        loaded = [event for event in events if event["event_type"] == "PROJECT_INSTRUCTIONS_LOADED"]
        assert loaded and loaded[0]["data"]["paths"] == ["AGENTS.md"]
    finally:
        await runtime.close()
