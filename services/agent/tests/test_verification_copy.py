"""失败时基线复制不得带入密钥、依赖目录或链接目标。"""

from pathlib import Path

import pytest
from bit_agent.runtime.infrastructure.verification_support.baseline import copy_workspace


def test_baseline_copy_skips_protected_paths_and_cache(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "app.py").write_text("x = 1\n")
    for name in (".env", ".env.local", "id_ed25519", "private.pem"):
        (root / name).write_text("secret")
    for name in (".git", ".ssh", ".venv", "node_modules", "__pycache__", ".pytest_cache"):
        directory = root / name
        directory.mkdir()
        (directory / "secret.txt").write_text("secret")
    destination = tmp_path / "copy"
    copy_workspace(root, destination)
    assert sorted(path.name for path in destination.iterdir()) == ["app.py"]
    assert (destination / "app.py").read_text() == "x = 1\n"


def test_baseline_copy_omits_file_and_directory_links(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "key.txt").write_text("secret")
    try:
        (root / "link.txt").symlink_to(outside / "key.txt")
        (root / "linked").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("当前用户不能创建符号链接")
    destination = tmp_path / "copy"
    copy_workspace(root, destination)
    assert list(destination.iterdir()) == []


def test_baseline_copy_does_not_recurse_into_destination_parent(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "app.py").write_text("x = 1\n")
    temporary = root / "temporary"
    temporary.mkdir()
    destination = temporary / "copy"
    copy_workspace(root, destination)
    assert sorted(path.name for path in destination.iterdir()) == ["app.py"]
