"""何时需要独立验收：执行设置里选“自动 / 总是 / 关闭”，自动模式按改动大小决定。"""

from pathlib import PurePosixPath
from typing import Literal

AcceptanceMode = Literal["auto", "always", "off"]
ACCEPTANCE_MODES: frozenset[str] = frozenset({"auto", "always", "off"})
DEFAULT_ACCEPTANCE_MODE: AcceptanceMode = "auto"
# 独立验收要再派一个 Agent 读代码、写测试、运行，通常要几分钟；
# 小修小改只做基础检查，达到任一门槛才验收。
AUTO_MIN_CHANGED_LINES = 60
AUTO_MIN_CHANGED_FILES = 3
_DOC_SUFFIXES = frozenset({".md", ".markdown", ".rst", ".txt", ".adoc", ".png", ".jpg", ".svg"})
# 主 Agent 的运行说明：按设置告诉它什么时候调用 verify_task。
ACCEPTANCE_INSTRUCTIONS: dict[str, str] = {
    "always": "基础检查通过后调用 verify_task 独立验收；两者都通过才可宣称完成。",
    "auto": (
        "基础检查结果中 acceptance 为 required 时，再调用 verify_task 独立验收，两者都通过才可"
        "宣称完成；为 skipped 时不要调用 verify_task，基础检查通过即可给出最终回答。"
    ),
    "off": "",
}


def _code_files(paths: set[str]) -> int:
    return sum(
        1
        for path in paths
        if PurePosixPath(path.replace("\\", "/")).suffix.lower() not in _DOC_SUFFIXES
    )


def acceptance_decision(mode: str, paths: set[str], changed_lines: int) -> tuple[bool, str]:
    """返回（是否需要独立验收，给模型和界面看的一句说明）。"""
    if mode == "off":
        return False, "执行设置已关闭独立验收"
    if mode == "always":
        return True, "执行设置要求每次修改都做独立验收"
    files = _code_files(paths)
    size = f"本轮改动 {changed_lines} 行、{files} 个代码文件"
    if changed_lines >= AUTO_MIN_CHANGED_LINES or files >= AUTO_MIN_CHANGED_FILES:
        return True, f"{size}，改动较大，需要独立验收"
    return False, f"{size}，改动较小，不做独立验收"
