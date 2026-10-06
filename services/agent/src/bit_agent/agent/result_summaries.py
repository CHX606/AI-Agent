"""工具行下面那一句结果：说清实际跑了什么、改了多少，而不是只写“通过”“完成”。"""

import json
import re
from pathlib import PurePath
from typing import Any

_PYTEST_COUNT = re.compile(r"(\d+) (passed|failed|errors?|skipped)\b")
_RUFF_ITEM = re.compile(r"^[^\s:][^:]*:\d+:\d+: [A-Za-z]+[0-9]*", re.MULTILINE)
_PYTEST_WORDS = {"failed": "失败", "error": "出错", "errors": "出错", "passed": "通过"}
_PYTEST_ORDER = ("失败", "出错", "通过")
MAX_SUMMARY = 160


def _tool(command: object) -> str:
    parts = [str(part) for part in command] if isinstance(command, list) else []
    for name in ("pytest", "ruff", "mypy"):
        if name in parts:
            return name
    return " ".join([PurePath(parts[0]).stem, *parts[1:3]]) if parts else "检查"


def _pytest(check: dict) -> str:
    if check.get("exit_code") == 5:
        return "pytest 没有收集到测试"
    counts: dict[str, int] = {}
    for line in str(check.get("stdout") or "").strip().splitlines()[-5:]:
        for number, kind in _PYTEST_COUNT.findall(line):
            if kind in _PYTEST_WORDS:
                word = _PYTEST_WORDS[kind]
                counts[word] = counts.get(word, 0) + int(number)
    if not counts:
        return "pytest 通过" if check.get("exit_code") == 0 else "pytest 未通过"
    return "pytest " + "，".join(
        f"{counts[word]} 个{word}" for word in _PYTEST_ORDER if word in counts
    )


def describe_check(check: dict) -> str:
    """一条检查命令的结果，例如“pytest 13 个通过”“ruff 2 个问题”。"""
    tool = _tool(check.get("command"))
    if check.get("start_error"):
        return f"{tool} 无法启动"
    if check.get("timed_out"):
        return f"{tool} 超时"
    if tool == "pytest":
        text = _pytest(check)
    elif tool == "ruff":
        found = len(_RUFF_ITEM.findall(str(check.get("stdout") or "")))
        text = (
            "ruff 无问题"
            if check.get("exit_code") == 0
            else f"ruff {found} 个问题"
            if found
            else "ruff 未通过"
        )
    else:
        text = f"{tool} {'通过' if check.get('exit_code') == 0 else '未通过'}"
    return text + ("（修改前就有）" if check.get("status") == "PRE_EXISTING" else "")


def verify_project_summary(output: dict) -> str:
    checks = "，".join(
        describe_check(item) for item in output.get("checks", [])[:4] if isinstance(item, dict)
    )
    outcome = output.get("outcome")
    if outcome == "PASSED":
        text = checks or "检查通过"
        return text + ("，无需独立验收" if output.get("acceptance") == "skipped" else "")
    if outcome == "FAILED":
        return "出现新的失败" + (f"：{checks}" if checks else "")
    if outcome == "NOT_APPLICABLE":
        return "只改了文档，无需检查"
    reasons = [
        item.get("reason") for item in output.get("unverified", []) if isinstance(item, dict)
    ]
    return "无法自动验证" + (f"：{reasons[0]}" if reasons and reasons[0] else "")


def _first_sentence(text: object) -> str:
    return re.split(r"[。\n]", str(text or "").strip(), maxsplit=1)[0]


def verify_task_summary(output: dict, error_message: str | None) -> str:
    verdict = output.get("verdict")
    if verdict == "PASSED":
        return "验收通过"
    reason = _first_sentence(output.get("summary") or error_message)
    title = "验收发现问题" if verdict == "FAILED" else "验收未完成"
    return title + (f"：{reason}" if reason else "")


def patch_summary(raw_arguments: str | None, files: int) -> str:
    """像 Claude Code 一样写增删行数：+12 −3；多个文件时前面加文件数。"""
    try:
        patch = json.loads(raw_arguments or "{}").get("patch")
    except (json.JSONDecodeError, AttributeError):
        patch = None
    if not isinstance(patch, str):
        return f"修改 {files} 个文件"
    lines = patch.splitlines()
    added = sum(1 for line in lines if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in lines if line.startswith("-") and not line.startswith("---"))
    counts = f"+{added} −{removed}"
    return counts if files <= 1 else f"{files} 个文件 {counts}"


def clip(text: Any) -> str:
    value = str(text)
    return value if len(value) <= MAX_SUMMARY else value[: MAX_SUMMARY - 1] + "…"
