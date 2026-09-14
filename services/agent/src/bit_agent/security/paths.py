"""工作区路径解析与安全校验。"""

from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Literal

PathErrorCode = Literal[
    "INVALID_ARGUMENT",
    "PATH_OUTSIDE_WORKSPACE",
    "PROTECTED_PATH",
]

PROTECTED_DIRECTORIES = frozenset(
    {
        ".git",
        ".ssh",
        ".venv",
        "node_modules",
    }
)

PRIVATE_KEY_NAMES = frozenset(
    {
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    }
)

PRIVATE_KEY_SUFFIXES = frozenset(
    {
        ".key",
        ".pem",
        ".p12",
        ".pfx",
    }
)


class PathSecurityError(ValueError):
    """路径不满足安全规则。"""

    def __init__(self, code: PathErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


def _canonical_name(name: str) -> str:
    """兼容 Windows 对文件名尾部空格和点的处理。"""
    return name.rstrip(" .").casefold()


def _validate_protected_parts(parts: list[str]) -> None:
    for part in parts:
        name = _canonical_name(part)

        if name in PROTECTED_DIRECTORIES:
            raise PathSecurityError(
                "PROTECTED_PATH",
                f"禁止访问受保护目录：{part}",
            )

        if name == ".env" or name.startswith(".env."):
            raise PathSecurityError(
                "PROTECTED_PATH",
                f"禁止访问环境变量文件：{part}",
            )

        if name in PRIVATE_KEY_NAMES:
            raise PathSecurityError(
                "PROTECTED_PATH",
                f"禁止访问私钥文件：{part}",
            )

        if any(name.endswith(suffix) for suffix in PRIVATE_KEY_SUFFIXES):
            raise PathSecurityError(
                "PROTECTED_PATH",
                f"禁止访问密钥文件：{part}",
            )


def resolve_workspace_path(
    workspace_root: Path,
    relative_path: str,
    *,
    allow_root: bool = False,
) -> Path:
    """安全地将工作区相对路径解析为绝对路径。"""

    if not isinstance(workspace_root, Path):
        raise PathSecurityError(
            "INVALID_ARGUMENT",
            "workspace_root 必须是 Path 对象",
        )

    try:
        root = workspace_root.resolve(strict=True)
    except OSError as exc:
        raise PathSecurityError(
            "INVALID_ARGUMENT",
            "workspace_root 不存在或无法访问",
        ) from exc

    if not root.is_dir():
        raise PathSecurityError(
            "INVALID_ARGUMENT",
            "workspace_root 必须是目录",
        )

    if not isinstance(relative_path, str):
        raise PathSecurityError(
            "INVALID_ARGUMENT",
            "relative_path 必须是字符串",
        )

    if "\x00" in relative_path:
        raise PathSecurityError(
            "INVALID_ARGUMENT",
            "路径不能包含空字节",
        )

    normalized = relative_path.replace("\\", "/")

    posix_path = PurePosixPath(normalized)
    windows_path = PureWindowsPath(normalized)

    if posix_path.is_absolute() or windows_path.is_absolute() or bool(windows_path.drive):
        raise PathSecurityError(
            "PATH_OUTSIDE_WORKSPACE",
            "只允许工作区相对路径",
        )

    parts = [part for part in normalized.split("/") if part not in {"", "."}]

    if not parts and not allow_root:
        raise PathSecurityError(
            "INVALID_ARGUMENT",
            "路径不能为空",
        )

    if any(part == ".." for part in parts):
        raise PathSecurityError(
            "PATH_OUTSIDE_WORKSPACE",
            "路径不能包含 ..",
        )

    # 防止 Windows NTFS Alternate Data Stream 路径。
    if any(":" in part for part in parts):
        raise PathSecurityError(
            "INVALID_ARGUMENT",
            "路径组件不能包含冒号",
        )

    _validate_protected_parts(parts)

    try:
        target = root.joinpath(*parts).resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise PathSecurityError(
            "INVALID_ARGUMENT",
            "路径无法解析",
        ) from exc

    # resolve() 会解析符号链接和 Windows Junction。
    if not target.is_relative_to(root):
        raise PathSecurityError(
            "PATH_OUTSIDE_WORKSPACE",
            "路径解析后越过工作区边界",
        )

    _validate_protected_parts(list(target.relative_to(root).parts))
    return target
