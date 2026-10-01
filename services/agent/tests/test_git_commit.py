"""把任务改动提交到 Git：只提交任务的文件，不碰用户自己的其他改动。"""

import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.domain.errors import InteractionError
from bit_agent.runtime.infrastructure.git import GitRepository

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="需要本机 Git")


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, capture_output=True, encoding="utf-8"
    ).stdout


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "core.autocrlf", "false")
    for name in ("a.py", "old.py", "user.py", "staged.py"):
        (root / name).write_bytes(f"{name}\n".encode())
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "initial")
    return root


async def test_outside_repository(tmp_path):
    assert (await GitRepository().status(tmp_path, ["a.py"]))["repository"] is False


async def test_commits_only_task_files(repo):
    # 任务改了 a.py、新建 new.py、删除 old.py；用户自己改了 user.py，并暂存了 staged.py。
    (repo / "a.py").write_text("changed\n")
    (repo / "new.py").write_text("new\n")
    (repo / "old.py").unlink()
    (repo / "user.py").write_text("user work\n")
    (repo / "staged.py").write_text("user staged\n")
    git(repo, "add", "staged.py")

    status = await GitRepository().status(repo, ["a.py", "new.py", "old.py", "same.py"])
    assert status["branch"] == "main"
    assert {item["path"]: item["status"] for item in status["files"]} == {
        "a.py": "M",
        "new.py": "??",
        "old.py": "D",
    }

    result = await GitRepository().commit(repo, ["a.py", "new.py", "old.py"], "任务提交")
    assert result["branch"] == "main"
    committed = git(repo, "show", "--name-status", "--format=%s", "HEAD").split()
    assert committed[0] == "任务提交"
    assert set(committed[1:]) == {"M", "a.py", "A", "new.py", "D", "old.py"}
    remaining = git(repo, "status", "--porcelain")
    assert " M user.py" in remaining and "M  staged.py" in remaining


async def test_commit_to_new_branch(repo):
    (repo / "a.py").write_text("changed\n")
    result = await GitRepository().commit(repo, ["a.py"], "on branch", "bit-agent/fix-a")
    assert result["branch"] == "bit-agent/fix-a"
    assert git(repo, "log", "-1", "--format=%s", "main").strip() == "initial"


async def test_nothing_to_commit(repo):
    with pytest.raises(InteractionError, match="没有改动"):
        await GitRepository().commit(repo, ["a.py"], "nothing")


async def test_workspace_in_repository_subdirectory(repo):
    (repo / "pkg").mkdir()
    (repo / "pkg" / "mod.py").write_text("x\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "pkg")
    (repo / "pkg" / "mod.py").write_text("y\n")
    status = await GitRepository().status(repo / "pkg", ["mod.py"])
    assert status["files"] == [{"path": "mod.py", "status": "M"}]
    await GitRepository().commit(repo / "pkg", ["mod.py"], "sub")
    assert git(repo, "show", "--name-only", "--format=", "HEAD").split() == ["pkg/mod.py"]


async def test_invalid_branch_name(repo):
    (repo / "a.py").write_text("changed\n")
    with pytest.raises(InteractionError, match="分支名"):
        await GitRepository().commit(repo, ["a.py"], "x", "bad..name")


async def test_runtime_commits_files_changed_by_task(repo, tmp_path, monkeypatch):
    class Responses:
        def create(self, **request):
            done = any(item.get("type") == "function_call_output" for item in request["input"])
            if done:
                return SimpleNamespace(output=[], output_text="改好了")
            call = SimpleNamespace(
                type="function_call",
                call_id="patch",
                name="apply_patch",
                arguments=json.dumps(
                    {
                        "patch": "*** Begin Patch\n*** Update File: a.py\n@@\n-a.py\n+fixed\n"
                        "*** End Patch\n"
                    }
                ),
            )
            return SimpleNamespace(output=[call], output_text="")

    monkeypatch.setitem(
        sys.modules,
        "bit_agent.llm.client",
        SimpleNamespace(client=SimpleNamespace(responses=Responses()), model_name="fixture"),
    )
    # 只关心提交；验证结果按“无法验证”处理即可。
    runtime = create_runtime(tmp_path / "data")

    async def unverified(root, changed, call_id, originals=None):
        from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus

        return ToolResult(
            tool_call_id=call_id,
            tool_name="verify_project",
            status=ToolStatus.ERROR,
            output={"outcome": "UNVERIFIED", "unverified": [], "notes": []},
            error=ToolError(code="VERIFICATION_UNAVAILABLE", message="x", retryable=False),
            metadata=ToolMetadata(duration_ms=0),
        )

    runtime.verifier = unverified
    await runtime.start()
    try:
        task = await runtime.create_task(
            {
                "objective": "修复 a.py\n详细说明",
                "workspace_root": str(repo),
                "multi_agent_mode": "off",
                "permission_mode": "edit",
            }
        )
        await asyncio.wait_for(runtime._running[task["task_id"]], 10)
        status = await runtime.git_status(task["task_id"])
        assert status["task_files"] == ["a.py"]
        assert status["files"] == [{"path": "a.py", "status": "M"}]
        # 模型配置不可用时退回到按任务目标生成的草稿。
        suggestion = await runtime.suggest_commit_message(task["task_id"])
        assert suggestion == {"message": "修复 a.py", "generated": False}
        with pytest.raises(InteractionError):
            await runtime.commit_changes(task["task_id"], {"message": " "})
        result = await runtime.commit_changes(task["task_id"], {"message": "修复 a.py"})
        assert git(repo, "show", "--name-only", "--format=%s", "HEAD").split() == [
            "修复",
            "a.py",
            "a.py",
        ]
        assert result["files"] == ["a.py"]
        events = await runtime.read_events(task["task_id"])
        assert any(event["event_type"] == "CHANGES_COMMITTED" for event in events)
    finally:
        await runtime.close()
