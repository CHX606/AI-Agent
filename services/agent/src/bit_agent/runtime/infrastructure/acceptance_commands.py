"""Construct fixed acceptance commands using the original project's toolchain."""

import re
from pathlib import Path

from bit_agent.security.paths import resolve_workspace_path
from bit_agent.tools.command_runtime import python_executable
from bit_agent.tools.run_tests import _is_allowed_test_target

from .verification import PYTHON_MARKERS
from .verification_support.node_manifest import node_manifest


def _looks_like_python(directory: Path) -> bool:
    if any((directory / marker).is_file() for marker in PYTHON_MARKERS):
        return True
    if any(item.is_file() for item in directory.glob("requirements*.txt")):
        return True
    return any(item.is_file() for pattern in ("*.py", "*/*.py") for item in directory.glob(pattern))


def _test_target(directory: Path, target: str) -> str:
    path = resolve_workspace_path(directory, target, allow_root=True)
    if not path.exists():
        raise ValueError("测试目标不存在")
    if target and not _is_allowed_test_target(path, directory):
        if not path.is_file() or not re.search(r"\.test\.(?:[cm]?js|tsx?)$", target):
            raise ValueError("只允许运行测试文件或测试目录")
    return path.relative_to(directory).as_posix()


def acceptance_command(directory: Path, source: Path, target: str, language: str) -> list[str]:
    relative = _test_target(directory, target)
    if language == "python" and _looks_like_python(directory):
        command = [python_executable(source), "-m", "pytest", "-q"]
        return command + (["--", relative] if target else [])
    if language == "node" and (directory / "package.json").is_file():
        manifest, manager, _ = node_manifest(directory)
        scripts = manifest.get("scripts")
        if not isinstance(scripts, dict) or not scripts.get("test"):
            raise ValueError("项目没有 test 脚本")
        command = [manager, "run", "test"]
        return command + (["--", "./" + relative] if target else [])
    raise ValueError("目前只支持配置了 pytest 或 Node test 脚本的项目")
