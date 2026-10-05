"""项目验证命令配置，不包含运行环境或镜像设置。"""

import json
from pathlib import Path

from bit_agent.security.paths import PathSecurityError, resolve_workspace_path

CONFIG_PATH = ".bit-agent/verify.json"
DEFAULT_TIMEOUT_SECONDS = 300


class VerificationConfigError(ValueError):
    """项目自己的验证配置不合法。"""


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


def _project_directory(root: Path, relative: object) -> Path:
    if not isinstance(relative, str):
        raise VerificationConfigError("path 必须是工作区内的相对目录")
    try:
        directory = resolve_workspace_path(root, relative, allow_root=True)
    except PathSecurityError as exc:
        raise VerificationConfigError(f"path 不在工作区内：{relative}") from exc
    if not directory.is_dir():
        raise VerificationConfigError(f"项目目录不存在：{relative or '.'}")
    return directory


def _project(root: Path, item: object) -> dict:
    allowed = {"path", "language", "commands", "timeout_seconds"}
    if not isinstance(item, dict) or not set(item) <= allowed:
        raise VerificationConfigError("项目配置只支持 " + "、".join(sorted(allowed)))
    directory = _project_directory(root, item.get("path", ""))
    language = item.get("language")
    if language not in {"python", "node", "custom"}:
        raise VerificationConfigError("language 只能是 python、node 或 custom")
    commands = item.get("commands")
    if not isinstance(commands, list) or not 1 <= len(commands) <= 10:
        raise VerificationConfigError("commands 必须是 1 到 10 条命令")
    timeout = item.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    if type(timeout) is not int or not 10 <= timeout <= 1800:
        raise VerificationConfigError("timeout_seconds 必须是 10 到 1800 之间的整数")
    return {
        "root": directory,
        "language": language,
        "commands": [_command_list(command) for command in commands],
        "timeout": timeout,
        "configured": True,
    }


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
    raw_projects = data.get("projects", [])
    if not isinstance(raw_projects, list) or len(raw_projects) > 20:
        raise VerificationConfigError("projects 必须是最多 20 项的数组")
    return {"projects": [_project(root, item) for item in raw_projects], "skip": skip}
