"""选择固定 Python 工具命令使用的工作区运行环境。"""

import re
import sys
from pathlib import Path


def python_executable(workspace_root: Path) -> str:
    """优先使用工作区虚拟环境，否则使用当前 Agent 的 Python。"""
    candidates = (
        workspace_root / ".venv" / "Scripts" / "python.exe",
        workspace_root / ".venv" / "bin" / "python",
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return sys.executable


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
