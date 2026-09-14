import json
from pathlib import Path
from typing import Any

from bit_agent.cli import main
from bit_agent.client import GatewayEvent


class FakeGatewayClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.created: tuple[str, str] | None = None

    def create_task(self, objective: str, workspace_root: str) -> dict[str, Any]:
        self.created = (objective, workspace_root)
        return {"task_id": "task-1", "status": "QUEUED"}

    def iter_events(self, task_id: str):
        assert task_id == "task-1"
        yield GatewayEvent("1-0", "TOOL_COMPLETED", {"agent_id": "main"})

    def get_task(self, task_id: str) -> dict[str, Any]:
        return {"task_id": task_id, "status": "RUNNING"}

    def get_result(self, task_id: str) -> dict[str, Any]:
        return {"task_id": task_id, "status": "COMPLETED", "result": {"rounds": 3}}

    def cancel_task(self, task_id: str) -> dict[str, Any]:
        return {"task_id": task_id, "status": "CANCELLATION_REQUESTED"}


def test_run_follows_events_and_prints_final_json(tmp_path: Path, capsys) -> None:
    clients: list[FakeGatewayClient] = []

    def factory(base_url: str) -> FakeGatewayClient:
        client = FakeGatewayClient(base_url)
        clients.append(client)
        return client

    exit_code = main(
        ["run", "--workspace", str(tmp_path), "--task", "修复失败测试"],
        client_factory=factory,  # type: ignore[arg-type]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "任务已提交：task-1" in output
    assert "TOOL_COMPLETED [main]" in output
    assert '"status": "COMPLETED"' in output
    assert clients[0].created == ("修复失败测试", str(tmp_path.resolve()))


def test_run_json_mode_prints_only_result(tmp_path: Path, capsys) -> None:
    exit_code = main(
        ["run", "--workspace", str(tmp_path), "--task", "任务", "--json"],
        client_factory=FakeGatewayClient,  # type: ignore[arg-type]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert json.loads(output)["status"] == "COMPLETED"


def test_status_and_cancel_commands(capsys) -> None:
    status_code = main(
        ["status", "task-2"],
        client_factory=FakeGatewayClient,  # type: ignore[arg-type]
    )
    status_output = capsys.readouterr().out
    cancel_code = main(
        ["cancel", "task-2", "--json"],
        client_factory=FakeGatewayClient,  # type: ignore[arg-type]
    )
    cancel_output = capsys.readouterr().out

    assert status_code == 0
    assert status_output.strip() == "task-2  RUNNING"
    assert cancel_code == 0
    assert json.loads(cancel_output)["status"] == "CANCELLATION_REQUESTED"


def test_missing_workspace_returns_error(tmp_path: Path, capsys) -> None:
    exit_code = main(
        ["run", "--workspace", str(tmp_path / "missing"), "--task", "任务"],
        client_factory=FakeGatewayClient,  # type: ignore[arg-type]
    )

    assert exit_code == 1
    assert "工作区不存在" in capsys.readouterr().err
