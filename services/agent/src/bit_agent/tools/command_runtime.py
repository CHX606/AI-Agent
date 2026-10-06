"""选择固定 Python 工具命令使用的工作区运行环境。"""

import re
import sys
from pathlib import Path


def python_executable(workspace_root: Path, fallback_root: Path | None = None) -> str:
    """优先使用项目目录的虚拟环境，其次是工作区根目录的，否则使用当前 Agent 的 Python。"""
    roots = (
        [workspace_root]
        if fallback_root in {None, workspace_root}
        else [workspace_root, fallback_root]
    )
    for root in roots:
        for candidate in (
            root / ".venv" / "Scripts" / "python.exe",
            root / ".venv" / "bin" / "python",
        ):
            if candidate.is_file():
                return str(candidate)
    return sys.executable


def python_import_roots(directory: Path, interpreter: str) -> list[Path]:
    """副本里用原工作区的虚拟环境时，让副本的源码排在可编辑安装指向的原目录之前。"""
    program = Path(interpreter)
    if (
        interpreter == sys.executable
        or program.is_relative_to(directory)
        or not (program.parent.parent / "pyvenv.cfg").is_file()
    ):
        return []
    source = directory / "src"
    return [source, directory] if source.is_dir() else [directory]


def command_dependency_error(command: list[str], stdout: str, stderr: str) -> str:
    """缺少检查工具或构建后端依赖时，明确区分不能验证与检查失败。"""
    text = stdout + "\n" + stderr
    module = next((name for name in ("pytest", "ruff", "mypy", "build") if name in command), None)
    if module and re.search(rf"No module named ['\"]?{module}(?:[.\s'\"]|$)", text):
        return f"本机 Python 缺少 {module}，无法运行该检查"
    missing_backend = re.search(r"No module named ['\"]?setuptools(?:[.\s'\"]|$)", text)
    if "build" in command and (
        missing_backend
        or any(
            marker in text
            for marker in (
                "BackendUnavailable",
                "Missing dependencies:",
                "Cannot find module",
                "command not found",
                "is not recognized as an internal or external command",
            )
        )
    ):
        return "本机缺少构建依赖，无法运行构建检查：" + text.strip()[-1000:]
    return ""
