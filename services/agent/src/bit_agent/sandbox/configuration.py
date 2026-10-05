"""Resolve the pinned official SDK's trusted Windows runtime files."""

import os
import sys
from pathlib import Path

VERSION = "0.0.78"
RESOURCES = ("node.exe", "sandbox-runner.mjs", "srt-win.exe")
ENVIRONMENT_KEYS = {
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMDATA",
    "LANG",
    "PNPM_HOME",
}


def runtime_paths() -> tuple[Path, Path, Path]:
    if sys.platform != "win32":
        raise RuntimeError("当前便携版的原生沙箱仅支持 Windows")
    data = os.environ.get("LOCALAPPDATA")
    if not data:
        raise RuntimeError("无法定位沙箱执行器缓存")
    cache = Path(data) / "BitAgent" / "sandbox-executor" / VERSION
    keys = ("BIT_AGENT_SANDBOX_NODE", "BIT_AGENT_SANDBOX_BROKER", "BIT_AGENT_SANDBOX_EXECUTABLE")
    paths = tuple(
        Path(os.environ.get(key) or cache / name) for key, name in zip(keys, RESOURCES, strict=True)
    )
    if any(not path.is_file() or path.is_symlink() for path in paths):
        raise RuntimeError("官方 Windows 沙箱执行文件不完整或是链接，拒绝执行")
    return paths[0].resolve(), paths[1].resolve(), paths[2].resolve()


def executable() -> Path:
    return runtime_paths()[2]


def environment() -> dict[str, str]:
    values = {key: value for key, value in os.environ.items() if key.upper() in ENVIRONMENT_KEYS}
    node, broker, helper = runtime_paths()
    values.update(
        BIT_AGENT_SANDBOX_NODE=str(node),
        BIT_AGENT_SANDBOX_BROKER=str(broker),
        BIT_AGENT_SANDBOX_EXECUTABLE=str(helper),
        PYTHONDONTWRITEBYTECODE="1",
        PYTEST_ADDOPTS="-p no:cacheprovider",
        PYTHONIOENCODING="utf-8",
    )
    return values


def validate_locations(root: Path, *programs: Path) -> None:
    if any(path.is_relative_to(root) for path in programs):
        raise ValueError("沙箱执行文件不能位于可写的任务工作区内")
