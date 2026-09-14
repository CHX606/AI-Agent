from pathlib import Path

import pytest
from bit_agent.security.paths import (
    PathSecurityError,
    resolve_workspace_path,
)


def test_resolves_normal_relative_path(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    target = resolve_workspace_path(workspace, "src/main.py")

    assert target == (workspace / "src/main.py").resolve()


def test_rejects_parent_path_traversal(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with pytest.raises(PathSecurityError) as exc_info:
        resolve_workspace_path(workspace, "../secret.txt")

    assert exc_info.value.code == "PATH_OUTSIDE_WORKSPACE"


def test_rejects_windows_absolute_path(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with pytest.raises(PathSecurityError) as exc_info:
        resolve_workspace_path(
            workspace,
            r"C:\Users\Administrator\.ssh\id_rsa",
        )

    assert exc_info.value.code == "PATH_OUTSIDE_WORKSPACE"


def test_rejects_git_directory(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with pytest.raises(PathSecurityError) as exc_info:
        resolve_workspace_path(workspace, ".git/config")

    assert exc_info.value.code == "PROTECTED_PATH"


def test_rejects_env_file(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with pytest.raises(PathSecurityError) as exc_info:
        resolve_workspace_path(workspace, ".env")

    assert exc_info.value.code == "PROTECTED_PATH"


def test_rejects_symlink_escape(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()

    link = workspace / "external"

    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("当前系统不允许创建符号链接")

    with pytest.raises(PathSecurityError) as exc_info:
        resolve_workspace_path(workspace, "external/secret.txt")

    assert exc_info.value.code == "PATH_OUTSIDE_WORKSPACE"
