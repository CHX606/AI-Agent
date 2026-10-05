"""比较检查结果，仅对可识别的结果判断新增失败。"""

import re
from collections import Counter

_PYTEST_ITEM = re.compile(r"^(FAILED|ERROR) (.+?)(?: - .*)?$", re.MULTILINE)
_PYTEST_COUNT = re.compile(r"(\d+) (passed|failed|errors?)\b")
_RUFF_ITEM = re.compile(r"^(?P<path>[^\s:][^:]*):\d+:\d+: (?P<code>[A-Za-z]+[0-9]*)", re.MULTILINE)


def _passed(run: dict) -> bool:
    return not run["start_error"] and not run["timed_out"] and run["exit_code"] == 0


def _pytest_findings(run: dict) -> dict | None:
    """从 pytest 输出中取出失败的测试编号和通过数量；看不出结果时返回 None。"""
    text = run["stdout"] + "\n" + run["stderr"]
    counts = {"passed": 0, "failed": 0}
    found = False
    for line in text.strip().splitlines()[-15:]:
        for number, kind in _PYTEST_COUNT.findall(line):
            found = True
            counts["passed" if kind == "passed" else "failed"] += int(number)
    if not found and run["exit_code"] != 5:
        return None
    return {
        "failures": {f"{kind} {item}" for kind, item in _PYTEST_ITEM.findall(text)},
        "passed": counts["passed"],
        "failed": counts["failed"],
        "no_tests": run["exit_code"] == 5,
    }


def _ruff_findings(run: dict) -> Counter | None:
    if run["start_error"] or run["timed_out"] or run["exit_code"] not in {0, 1}:
        return None
    return Counter((match["path"], match["code"]) for match in _RUFF_ITEM.finditer(run["stdout"]))


def _kind(command: list[str]) -> str:
    if "pytest" in command:
        return "pytest"
    if "ruff" in command and "--output-format=concise" in command:
        return "ruff"
    return "generic"


def _compare_pytest(current: dict, baseline: dict) -> tuple[str, str] | None:
    now, before = _pytest_findings(current), _pytest_findings(baseline)
    if now is None or before is None:
        return None
    if now["no_tests"]:
        if before["no_tests"]:
            return "UNVERIFIED", "项目没有可以运行的测试"
        return "FAILED", "修改后收集不到任何测试，修改前可以"
    new = sorted(now["failures"] - before["failures"])
    if not new and current.get("truncated") and now["failed"] > before["failed"]:
        new = [f"失败数从 {before['failed']} 增加到 {now['failed']}（输出被截断）"]
    if new:
        return "FAILED", "修改后新出现的失败：" + "；".join(new[:20])
    if now["passed"] == 0:
        return "UNVERIFIED", "修改前后都没有通过的测试，可能是环境或测试收集问题"
    return "PRE_EXISTING", f"{now['failed']} 项失败在修改前就存在，不是本轮引入"


def _compare_ruff(current: dict, baseline: dict) -> tuple[str, str] | None:
    now, before = _ruff_findings(current), _ruff_findings(baseline)
    if now is None or before is None:
        return None
    new = now - before
    if new:
        return "FAILED", "修改后新出现的问题：" + "；".join(
            f"{path} {code} ×{count}" for (path, code), count in sorted(new.items())[:20]
        )
    return "PRE_EXISTING", "这些问题在修改前就存在，不是本轮引入"


def compare_with_baseline(command: list[str], current: dict, baseline: dict) -> tuple[str, str]:
    """当前失败时，与修改前同一命令的结果比较。"""
    kind = _kind(command)
    compared = (
        _compare_pytest(current, baseline)
        if kind == "pytest"
        else (_compare_ruff(current, baseline) if kind == "ruff" else None)
    )
    if compared is not None:
        return compared
    if _passed(baseline):
        return "FAILED", "修改前这条检查可以通过，修改后失败"
    reason = current["start_error"] or ("运行超时" if current["timed_out"] else "")
    return "UNVERIFIED", "这条检查在修改前就无法通过，无法区分是否引入了新问题" + (
        f"：{reason}" if reason else ""
    )
