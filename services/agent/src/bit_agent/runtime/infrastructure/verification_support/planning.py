"""把真实改动匹配到现有验证项目。"""

import fnmatch
from pathlib import Path, PurePosixPath

from bit_agent.security.paths import resolve_workspace_path

from .commands import default_commands, local_command
from .config import CONFIG_PATH, DEFAULT_TIMEOUT_SECONDS, load_config
from .node_manifest import ProjectEnvironmentError

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


def _default_project(root: Path, name: str) -> list[dict]:
    path = resolve_workspace_path(root, name, allow_root=True)
    directory = path if path.is_dir() else path.parent
    selected = []
    while directory == root or root in directory.parents:
        # 同级存在两种项目时都检查，不能用 Python 测试代替前端验证。
        if (directory / "package.json").is_file():
            selected.append({"root": directory, "language": "node"})
        if any((directory / marker).is_file() for marker in PYTHON_MARKERS) or any(
            item.is_file() for item in directory.glob("requirements*.txt")
        ):
            selected.append({"root": directory, "language": "python"})
        if selected or directory == root:
            break
        directory = directory.parent
    # 没有任何项目配置的 Python 脚本（例如只有 todo.py 和 tests/），在工作区根目录运行 pytest；
    # 没有测试时 pytest 收集不到用例，结论是“无法验证”而不是失败。
    if not selected and path.suffix == ".py":
        selected.append({"root": root, "language": "python"})
    return selected


def _collect_projects(root: Path, changed: list[str], config: dict) -> tuple[dict, list, dict]:
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
    return projects, skipped, unverifiable


def _project_plan(root: Path, project: dict, environment_root: Path | None) -> dict:
    relative = project["root"].relative_to(root).as_posix()
    if environment_root is not None:
        project = {
            **project,
            "environment": environment_root / relative,
            "environment_root": environment_root,
        }
    commands = project.get("commands") or default_commands(project, project["paths"])
    return {
        "root": "" if relative == "." else relative,
        "language": project["language"],
        "commands": [local_command(project, command) for command in commands],
        "timeout": project.get("timeout", DEFAULT_TIMEOUT_SECONDS),
        "configured": project.get("configured", False),
        "paths": project["paths"],
    }


def verification_plan(root: Path, changed: list[str], environment_root: Path | None = None) -> dict:
    """区分需要检查、不需要检查和不能自动验证的文件。

    environment_root 是在副本里检查时的原工作区，项目的 .venv 只在那里。
    """
    root = root.resolve()
    projects, skipped, unverifiable = _collect_projects(root, changed, load_config(root))
    plans = []
    for project in projects.values():
        try:
            plans.append(_project_plan(root, project, environment_root))
        except ProjectEnvironmentError as exc:
            unverifiable.setdefault(f"{exc}。{UNSUPPORTED_HINT}", []).extend(project["paths"])
    return {
        "projects": plans,
        "skipped": skipped,
        "unverifiable": [
            {"paths": sorted(set(paths)), "reason": reason}
            for reason, paths in unverifiable.items()
        ],
    }
