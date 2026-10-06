"""选择现有项目工具链的固定验证命令。"""

from pathlib import Path

from bit_agent.security.paths import resolve_workspace_path
from bit_agent.tools.command_runtime import python_executable

from .node_manifest import ProjectEnvironmentError, node_manifest


def _has_ruff_config(directory: Path) -> bool:
    if (directory / "ruff.toml").is_file() or (directory / ".ruff.toml").is_file():
        return True
    pyproject = directory / "pyproject.toml"
    try:
        return pyproject.is_file() and "[tool.ruff" in pyproject.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False


def project_python(project: dict) -> str:
    """副本里的检查用原工作区（environment）的虚拟环境，副本不复制 .venv。"""
    environment: Path = project.get("environment") or project["root"]
    workspace: Path = project.get("environment_root") or project["workspace"]
    return python_executable(environment, workspace)


def _python_commands(project: dict, paths: list[str]) -> list[list[str]]:
    directory: Path = project["root"]
    python = project_python(project)
    commands = [[python, "-m", "pytest", "-q", "-rfE"]]
    files = set()
    for name in paths:
        path = resolve_workspace_path(project["workspace"], name, allow_root=True)
        if path.suffix == ".py" and path.is_file() and directory in path.parents:
            files.add(path.relative_to(directory).as_posix())
    if files:
        commands.append(
            [
                python,
                "-m",
                "ruff",
                "check",
                "--no-cache",
                "--force-exclude",
                "--output-format=concise",
                *([] if _has_ruff_config(directory) else ["--select=E9,F"]),
                *sorted(files),
            ]
        )
    return commands


def local_command(project: dict, command: list[str]) -> list[str]:
    if command[0] in {"python", "python3"}:
        return [project_python(project), *command[1:]]
    return list(command)


def default_commands(project: dict, paths: list[str]) -> list[list[str]]:
    if project["language"] == "python":
        return _python_commands(project, paths)
    manifest, manager, _version = node_manifest(project["root"])
    scripts = manifest.get("scripts", {})
    if not isinstance(scripts, dict) or not scripts.get("test"):
        raise ProjectEnvironmentError("前端项目缺少 test 脚本，不能用构建成功代替测试")
    quality = [script for script in ("lint", "typecheck", "build") if scripts.get(script)]
    if not quality:
        raise ProjectEnvironmentError("前端项目至少需要 lint、typecheck 或 build 脚本")
    return [[manager, "run", script] for script in ("test", *quality)]
