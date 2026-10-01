"""按真实改动运行项目已有测试和质量检查，并与修改前的版本对比；不代替独立需求验收。

结论写在 output.outcome：
- PASSED：检查通过；或者失败项在本轮修改前就已存在（逐条比对 pytest / Ruff 结果）。
- FAILED：出现了修改前没有的失败，Agent 需要继续修复。
- UNVERIFIED：没有能运行的检查，例如不支持的语言、项目没有测试、Docker 不可用，
  或者修改前就失败且无法逐条比对。Agent 可以结束，但必须说明哪些改动没有验证。
- NOT_APPLICABLE：只改了文档这类不需要运行检查的文件。
"""

import asyncio
import base64
import fnmatch
import json
import re
import tempfile
import time
from collections import Counter
from pathlib import Path, PurePosixPath

from bit_agent.sandbox.docker import DockerSandbox, docker_status
from bit_agent.sandbox.environment import EnvironmentPreparationError
from bit_agent.sandbox.node_environment import node_manifest
from bit_agent.security.paths import PathSecurityError, resolve_workspace_path
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus

CONFIG_PATH = ".bit-agent/verify.json"
DEFAULT_TIMEOUT_SECONDS = 300
PYTHON_MARKERS = (
    "pyproject.toml",
    "pytest.ini",
    "setup.cfg",
    "setup.py",
    "tox.ini",
    "requirements.txt",
)
DOC_SUFFIXES = frozenset(
    {".md", ".markdown", ".rst", ".adoc", ".asciidoc", ".png", ".jpg", ".jpeg", ".gif", ".svg"}
    | {".webp", ".ico"}
)
DOC_NAMES = frozenset(
    {"readme", "license", "licence", "copying", "notice", "authors", "contributors"}
    | {"changelog", "changes", "history", "codeowners", ".gitignore", ".gitattributes"}
    | {".editorconfig", ".mailmap"}
)
UNSUPPORTED_HINT = (
    f"目前自动识别 Python 和单包 Node 项目；其他语言或多包项目可以在 {CONFIG_PATH} 中配置验证命令"
)
_IMAGE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}")
_PYTEST_ITEM = re.compile(r"^(FAILED|ERROR) (.+?)(?: - .*)?$", re.MULTILINE)
_PYTEST_COUNT = re.compile(r"(\d+) (passed|failed|errors?)\b")
_RUFF_ITEM = re.compile(r"^(?P<path>[^\s:][^:]*):\d+:\d+: (?P<code>[A-Za-z]+[0-9]*)", re.MULTILINE)


class VerificationConfigError(ValueError):
    """项目自己的验证配置不合法。"""


def _needs_no_checks(name: str, skip: list[str]) -> bool:
    """文档、图片和验证配置本身不需要运行测试；用户也可以用 skip 指定。"""
    if name in {"", "."}:
        return False
    if name.casefold().startswith(".bit-agent/"):
        return True
    if any(fnmatch.fnmatchcase(name, pattern) for pattern in skip):
        return True
    path = PurePosixPath(name.casefold())
    if path.suffix in DOC_SUFFIXES:
        return True
    return path.name in DOC_NAMES or (path.stem in DOC_NAMES and path.suffix in {"", ".txt"})


def _command_list(value: object) -> list[str]:
    if (
        not isinstance(value, list)
        or not 1 <= len(value) <= 50
        or any(
            not isinstance(part, str) or not part or len(part) > 1000 or "\0" in part
            for part in value
        )
    ):
        raise VerificationConfigError("每条命令必须是 1 到 50 个非空字符串组成的数组")
    return list(value)


def load_config(root: Path) -> dict:
    """读取 .bit-agent/verify.json；没有该文件时返回空配置。"""
    path = root / CONFIG_PATH
    if not path.exists():
        return {"projects": [], "skip": []}
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024:
        raise VerificationConfigError(f"{CONFIG_PATH} 必须是 64 KB 以内的普通文件")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerificationConfigError(f"{CONFIG_PATH} 不是有效的 JSON：{exc}") from exc
    if not isinstance(data, dict) or not set(data) <= {"projects", "skip"}:
        raise VerificationConfigError(f"{CONFIG_PATH} 只支持 projects 和 skip 两个字段")
    skip = data.get("skip", [])
    if (
        not isinstance(skip, list)
        or len(skip) > 100
        or any(not isinstance(item, str) or not item or len(item) > 200 for item in skip)
    ):
        raise VerificationConfigError("skip 必须是最多 100 个文件匹配模式")
    projects = []
    raw_projects = data.get("projects", [])
    if not isinstance(raw_projects, list) or len(raw_projects) > 20:
        raise VerificationConfigError("projects 必须是最多 20 项的数组")
    for item in raw_projects:
        allowed = {"path", "language", "image", "commands", "timeout_seconds"}
        if not isinstance(item, dict) or not set(item) <= allowed:
            raise VerificationConfigError("项目配置只支持 " + "、".join(sorted(allowed)))
        relative = item.get("path", "")
        if not isinstance(relative, str):
            raise VerificationConfigError("path 必须是工作区内的相对目录")
        try:
            directory = resolve_workspace_path(root, relative, allow_root=True)
        except PathSecurityError as exc:
            raise VerificationConfigError(f"path 不在工作区内：{relative}") from exc
        if not directory.is_dir():
            raise VerificationConfigError(f"项目目录不存在：{relative or '.'}")
        image = item.get("image")
        language = item.get("language", "custom" if image else None)
        if language not in {"python", "node", "custom"}:
            raise VerificationConfigError("language 只能是 python、node，或者提供 image")
        if language == "custom":
            if not isinstance(image, str) or not _IMAGE.fullmatch(image):
                raise VerificationConfigError("自定义项目必须提供合法的 Docker 镜像名 image")
        elif image is not None:
            raise VerificationConfigError("python、node 项目使用内置环境，不能同时指定 image")
        commands = item.get("commands")
        if not isinstance(commands, list) or not 1 <= len(commands) <= 10:
            raise VerificationConfigError("commands 必须是 1 到 10 条命令")
        timeout = item.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
        if type(timeout) is not int or not 10 <= timeout <= 1800:
            raise VerificationConfigError("timeout_seconds 必须是 10 到 1800 之间的整数")
        projects.append(
            {
                "root": directory,
                "language": language,
                "image": image,
                "commands": [_command_list(command) for command in commands],
                "timeout": timeout,
                "configured": True,
            }
        )
    return {"projects": projects, "skip": skip}


def _default_project(root: Path, name: str) -> list[dict]:
    path = resolve_workspace_path(root, name, allow_root=True)
    directory = path if path.is_dir() else path.parent
    selected = []
    while directory == root or root in directory.parents:
        # 同级存在两种项目时都检查，不能用 Python 测试代替前端验证。
        if (directory / "package.json").is_file():
            selected.append({"root": directory, "language": "node"})
        if any((directory / marker).is_file() for marker in PYTHON_MARKERS):
            selected.append({"root": directory, "language": "python"})
        if selected or directory == root:
            break
        directory = directory.parent
    return selected


def _default_commands(project: dict, paths: list[str]) -> list[list[str]]:
    directory: Path = project["root"]
    if project["language"] == "python":
        commands = [["python", "-m", "pytest", "-q", "-rfE"]]
        # Ruff 只检查本轮改到且仍存在的 Python 文件，再与修改前对比，不追究项目旧问题。
        files = set()
        for name in paths:
            path = resolve_workspace_path(project["workspace"], name, allow_root=True)
            if path.suffix == ".py" and path.is_file() and directory in path.parents:
                files.add(path.relative_to(directory).as_posix())
        if files:
            commands.append(
                [
                    "python",
                    "-m",
                    "ruff",
                    "check",
                    "--no-cache",
                    "--force-exclude",
                    "--output-format=concise",
                    # Windows 文件挂进 Linux 容器后都显示为可执行（777），可执行位规则会误报。
                    "--extend-ignore=EXE001,EXE002",
                    *sorted(files),
                ]
            )
        return commands
    manifest, manager, _version = node_manifest(directory)
    scripts = manifest.get("scripts", {})
    if not isinstance(scripts, dict) or not scripts.get("test"):
        raise EnvironmentPreparationError("前端项目缺少 test 脚本，不能用构建成功代替测试")
    quality = [script for script in ("lint", "typecheck", "build") if scripts.get(script)]
    if not quality:
        raise EnvironmentPreparationError("前端项目至少需要 lint、typecheck 或 build 脚本")
    return [[manager, "run", script] for script in ("test", *quality)]


def verification_plan(root: Path, changed: list[str]) -> dict:
    """把改动文件分成：要运行检查的项目、不需要检查的文件、无法自动验证的文件。"""
    root = root.resolve()
    config = load_config(root)
    configured = sorted(config["projects"], key=lambda item: len(item["root"].parts), reverse=True)
    projects: dict[tuple[str, str], dict] = {}
    skipped: list[str] = []
    unverifiable: dict[str, list[str]] = {}
    for name in changed:
        normalized = name.replace("\\", "/").strip("/")
        if _needs_no_checks(normalized, config["skip"]):
            skipped.append(name)
            continue
        path = resolve_workspace_path(root, normalized, allow_root=True)
        owner = next(
            (item for item in configured if path == item["root"] or item["root"] in path.parents),
            None,
        )
        selected = [owner] if owner else _default_project(root, normalized)
        if not selected:
            unverifiable.setdefault(f"找不到所属项目的测试配置。{UNSUPPORTED_HINT}", []).append(
                name
            )
            continue
        for project in selected:
            key = (str(project["root"]), project["language"])
            entry = projects.setdefault(key, {**project, "workspace": root, "paths": []})
            entry["paths"].append(normalized)
    plans = []
    for project in projects.values():
        relative = project["root"].relative_to(root).as_posix()
        try:
            commands = project.get("commands") or _default_commands(project, project["paths"])
        except EnvironmentPreparationError as exc:
            unverifiable.setdefault(f"{exc}。{UNSUPPORTED_HINT}", []).extend(project["paths"])
            continue
        plans.append(
            {
                "root": "" if relative == "." else relative,
                "language": project["language"],
                "image": project.get("image"),
                "commands": commands,
                "timeout": project.get("timeout", DEFAULT_TIMEOUT_SECONDS),
                "configured": project.get("configured", False),
                "paths": project["paths"],
            }
        )
    return {
        "projects": plans,
        "skipped": skipped,
        "unverifiable": [
            {"paths": sorted(set(paths)), "reason": reason}
            for reason, paths in unverifiable.items()
        ],
    }


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


def compare_with_baseline(command: list[str], current: dict, baseline: dict) -> tuple[str, str]:
    """当前失败时，与修改前同一命令的结果比较，返回 (status, 说明)。"""
    kind = _kind(command)
    if kind == "pytest":
        now, before = _pytest_findings(current), _pytest_findings(baseline)
        if now is not None and before is not None:
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
    elif kind == "ruff":
        now_items, before_items = _ruff_findings(current), _ruff_findings(baseline)
        if now_items is not None and before_items is not None:
            new = now_items - before_items
            if new:
                return "FAILED", "修改后新出现的问题：" + "；".join(
                    f"{path} {code} ×{count}" for (path, code), count in sorted(new.items())[:20]
                )
            return "PRE_EXISTING", "这些问题在修改前就存在，不是本轮引入"
    if _passed(baseline):
        return "FAILED", "修改前这条检查可以通过，修改后失败"
    reason = current["start_error"] or ("运行超时" if current["timed_out"] else "")
    return (
        "UNVERIFIED",
        "这条检查在修改前就无法通过，无法区分是否引入了新问题" + (f"：{reason}" if reason else ""),
    )


def _write_baseline(root: Path, originals: dict[str, str | None], destination: Path) -> None:
    """复制当前工作区，再把本轮改过的文件恢复成修改前的内容。"""
    DockerSandbox(task_id="verification", tool_call_id="baseline")._stage_workspace(
        root, destination
    )
    for name, content in originals.items():
        target = resolve_workspace_path(destination, name)
        if content is None:
            target.unlink(missing_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(content))


async def _run(directory: Path, project: dict, command: list[str], call_id: str) -> dict:
    sandbox = DockerSandbox(task_id="verification", tool_call_id=call_id, image=project["image"])
    sandbox.environment_kind = project["language"]
    outcome = await sandbox.run(directory, command, project["timeout"])
    return {
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "start_error": outcome.start_error,
        "timed_out": outcome.timed_out,
        "truncated": outcome.truncated,
    }


async def verify_project(
    root: Path,
    changed: list[str],
    call_id: str,
    originals: dict[str, str | None] | None = None,
) -> ToolResult:
    started = time.monotonic()
    root = root.resolve()
    checks: list[dict] = []
    notes: list[str] = []
    unverified: list[dict] = []
    failed = False
    try:
        plan = verification_plan(root, changed)
    except (VerificationConfigError, PathSecurityError, OSError) as exc:
        plan = {"projects": [], "skipped": [], "unverifiable": []}
        unverified.append({"paths": list(changed), "reason": f"验证配置无效：{exc}"})
    unverified.extend(plan["unverifiable"])
    # 只有本轮每个改动文件都知道修改前的内容，才能做前后对比；否则保守地按失败处理。
    comparable = bool(originals) and all(
        name.replace("\\", "/").strip("/") in originals for name in changed
    )
    with tempfile.TemporaryDirectory(prefix="bit-agent-baseline-") as temporary:
        baseline_root: Path | None = None
        docker_ready = True
        for project in plan["projects"]:
            if not docker_ready:
                unverified.append({"paths": project["paths"], "reason": "Docker 不可用"})
                continue
            directory = resolve_workspace_path(root, project["root"], allow_root=True)
            for command in project["commands"]:
                current = await _run(directory, project, command, call_id)
                record = {
                    "project": project["root"],
                    "language": project["language"],
                    "command": command,
                    **current,
                    "status": "PASSED",
                }
                if project["language"] == "node":
                    record["dependency_note"] = "隔离安装公开依赖；不执行安装脚本，不重放锁文件。"
                checks.append(record)
                if _passed(current):
                    continue
                if current["start_error"] and await docker_status() != "ready":
                    docker_ready = False
                    record["status"] = "UNVERIFIED"
                    unverified.append(
                        {
                            "paths": project["paths"],
                            "reason": "Docker 没有运行或未安装，无法在隔离环境中验证；"
                            "启动 Docker Desktop 后可以重新验证",
                        }
                    )
                    break
                if comparable:
                    if baseline_root is None:
                        baseline_root = Path(temporary).resolve() / "workspace"
                        await asyncio.to_thread(_write_baseline, root, originals, baseline_root)
                    before = await _run(
                        resolve_workspace_path(baseline_root, project["root"], allow_root=True),
                        project,
                        command,
                        call_id + "-baseline",
                    )
                    status, detail = compare_with_baseline(command, current, before)
                    record["baseline"] = {
                        "exit_code": before["exit_code"],
                        "start_error": before["start_error"],
                        "timed_out": before["timed_out"],
                    }
                else:
                    status, detail = "FAILED", "检查未通过"
                    if _kind(command) == "pytest" and current["exit_code"] == 5:
                        status, detail = "UNVERIFIED", "项目没有可以运行的测试"
                record["status"], record["detail"] = status, detail
                if status == "FAILED":
                    failed = True
                elif status == "UNVERIFIED":
                    unverified.append({"paths": project["paths"], "reason": detail})
                else:
                    notes.append(f"{' '.join(command)}：{detail}")
                if failed:
                    break
            if failed:
                break
    if plan["skipped"]:
        notes.append("以下文件不需要运行检查：" + "、".join(plan["skipped"][:20]))
    if failed:
        outcome = "FAILED"
    elif unverified:
        outcome = "UNVERIFIED"
    elif checks:
        outcome = "PASSED"
    else:
        outcome = "NOT_APPLICABLE"
    reasons = "；".join(
        f"{item['reason']}（{'、'.join(item['paths'][:5])}）" for item in unverified
    )
    error = {
        "FAILED": ToolError(
            code="VERIFICATION_FAILED",
            message="项目验证未通过：出现了修改前没有的失败，请查看 status 为 FAILED 的检查",
            retryable=False,
        ),
        "UNVERIFIED": ToolError(
            code="VERIFICATION_UNAVAILABLE",
            message=f"无法自动验证：{reasons}。不要为了通过验证去修改测试或验证配置；"
            "在最终回答中如实说明哪些改动没有经过验证。",
            retryable=False,
        ),
    }.get(outcome)
    return ToolResult(
        tool_call_id=call_id,
        tool_name="verify_project",
        status=ToolStatus.ERROR if error else ToolStatus.SUCCESS,
        output={
            "outcome": outcome,
            "verified": outcome == "PASSED",
            "scope": "baseline",
            "acceptance_verified": False,
            "checks": checks,
            "covered_paths": changed,
            "skipped_paths": plan["skipped"],
            "unverified": unverified,
            "notes": notes,
        },
        error=error,
        metadata=ToolMetadata(duration_ms=int((time.monotonic() - started) * 1000)),
    )
