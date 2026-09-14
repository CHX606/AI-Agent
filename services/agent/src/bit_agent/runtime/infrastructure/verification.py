"""根据被改文件运行已有测试与常规质量检查，不代替独立需求验收。"""

import time
from pathlib import Path

from bit_agent.sandbox.docker import DockerSandbox
from bit_agent.sandbox.node_environment import node_manifest
from bit_agent.security.paths import resolve_workspace_path
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


def verification_plan(root: Path, changed: list[str]) -> list[dict]:
    projects: dict[tuple[str, str], dict] = {}
    for name in changed:
        path = resolve_workspace_path(root, name, allow_root=True)
        directory = path if path.is_dir() else path.parent
        selected = []
        while directory == root or root in directory.parents:
            # 同级存在两种项目时都检查，不能用 Python 测试代替前端验证。
            if (directory / "package.json").is_file():
                selected.append((directory, "node"))
            if (directory / "pyproject.toml").is_file() or (directory / "pytest.ini").is_file():
                selected.append((directory, "python"))
            if selected or directory == root:
                break
            directory = directory.parent
        if not selected:
            raise ValueError(f"找不到 {name} 所属项目的测试配置，不能宣称已通过验证")
        for directory, language in selected:
            key = (str(directory), language)
            if key in projects:
                continue
            if language == "python":
                commands = [
                    ["python", "-m", "pytest", "-q"],
                    ["python", "-m", "ruff", "check", "--no-cache", "."],
                ]
            else:
                manifest, manager, _version = node_manifest(directory)
                scripts = manifest.get("scripts", {})
                if not isinstance(scripts, dict) or not scripts.get("test"):
                    raise ValueError("前端项目缺少 test 脚本，不能用构建成功代替测试")
                quality = [name for name in ("lint", "typecheck", "build") if scripts.get(name)]
                if not quality:
                    raise ValueError("前端项目至少需要 lint、typecheck 或 build 脚本")
                commands = [[manager, "run", script] for script in ("test", *quality)]
            projects[key] = {"root": str(directory), "language": language, "commands": commands}
    if not projects:
        raise ValueError("没有待验证的文件")
    return list(projects.values())


async def verify_project(root: Path, changed: list[str], call_id: str) -> ToolResult:
    started = time.monotonic()
    results = []
    error = None
    try:
        for project in verification_plan(root, changed):
            for command in project["commands"]:
                sandbox = DockerSandbox(task_id="verification", tool_call_id=call_id)
                sandbox.environment_kind = project["language"]
                outcome = await sandbox.run(Path(project["root"]), command, 300)
                record = {
                    "project": Path(project["root"]).relative_to(root).as_posix(),
                    "language": project["language"],
                    "command": command,
                    "exit_code": outcome.exit_code,
                    "stdout": outcome.stdout,
                    "stderr": outcome.stderr,
                    "start_error": outcome.start_error,
                    "timed_out": outcome.timed_out,
                }
                if project["language"] == "node":
                    record["dependency_note"] = "隔离安装公开依赖；不执行安装脚本，不重放锁文件。"
                results.append(record)
                if outcome.start_error or outcome.timed_out or outcome.exit_code != 0:
                    raise ValueError("项目验证未通过，请查看具体命令结果")
    except (ValueError, OSError, RuntimeError) as exc:
        error = str(exc)
    return ToolResult(
        tool_call_id=call_id,
        tool_name="verify_project",
        status=ToolStatus.ERROR if error else ToolStatus.SUCCESS,
        output={"verified": error is None, "scope": "baseline", "acceptance_verified": False,
                "checks": results, "covered_paths": changed},
        error=ToolError(code="VERIFICATION_FAILED", message=error, retryable=False)
        if error
        else None,
        metadata=ToolMetadata(duration_ms=int((time.monotonic() - started) * 1000)),
    )
