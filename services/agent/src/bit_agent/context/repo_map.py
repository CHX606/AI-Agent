"""从工作区生成排序稳定且不包含敏感路径的 RepoMap。"""

import os
from pathlib import Path

from bit_agent.models.repo_map import RepoMap
from bit_agent.security.paths import PathSecurityError, resolve_workspace_path

IGNORED_DIRECTORIES = frozenset(
    {
        ".git",
        ".pnpm-store",
        ".pytest-tmp",
        ".venv",
        "node_modules",
        "dist",
        "build",
        "coverage",
        "__pycache__",
        ".pytest_cache",
        ".ruff_cache",
    }
)

LANGUAGE_EXTENSIONS = (
    ("Python", frozenset({".py"})),
    ("TypeScript", frozenset({".ts", ".tsx"})),
    ("JavaScript", frozenset({".js", ".jsx"})),
    ("Java", frozenset({".java"})),
    ("Go", frozenset({".go"})),
    ("Rust", frozenset({".rs"})),
    ("Markdown", frozenset({".md"})),
    ("JSON", frozenset({".json"})),
    ("YAML", frozenset({".yaml", ".yml"})),
)

_ENTRY_NAMES = frozenset({"main.py", "app.py", "manage.py"})
_ENTRY_PATHS = frozenset(
    {
        "src/index.ts",
        "src/main.ts",
        "package.json",
        "pyproject.toml",
    }
)
_MANIFEST_NAMES = frozenset(
    {
        "pyproject.toml",
        "requirements.txt",
        "package.json",
        "pnpm-lock.yaml",
        "pom.xml",
        "build.gradle",
        "go.mod",
        "cargo.toml",
    }
)


def _is_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction and is_junction())


def _discover_files(root: Path, scan_depth: int) -> tuple[list[str], bool]:
    discovered: list[str] = []
    depth_truncated = False

    def walk(directory: Path, directory_depth: int) -> None:
        nonlocal depth_truncated
        try:
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda item: (item.name.casefold(), item.name))
        except OSError:
            return

        for entry in entries:
            path = Path(entry.path)
            name = entry.name
            if entry.is_symlink() or _is_junction(path):
                continue
            try:
                is_directory = entry.is_dir(follow_symlinks=False)
                is_file = entry.is_file(follow_symlinks=False)
            except OSError:
                continue

            if is_directory:
                if name.casefold() in IGNORED_DIRECTORIES:
                    continue
                if directory_depth >= scan_depth:
                    depth_truncated = True
                    continue
                walk(path, directory_depth + 1)
                continue

            if not is_file:
                continue
            relative = path.relative_to(root).as_posix()
            try:
                resolve_workspace_path(root, relative)
            except PathSecurityError:
                continue
            discovered.append(relative)

    walk(root, 0)
    return sorted(discovered), depth_truncated


def _language_counts(files: list[str]) -> dict[str, int]:
    suffix_counts: dict[str, int] = {}
    for relative in files:
        suffix = Path(relative).suffix.casefold()
        suffix_counts[suffix] = suffix_counts.get(suffix, 0) + 1

    languages: dict[str, int] = {}
    for language, extensions in LANGUAGE_EXTENSIONS:
        count = sum(suffix_counts.get(extension, 0) for extension in extensions)
        if count:
            languages[language] = count
    return languages


def _is_entry_file(relative: str) -> bool:
    lowered = relative.casefold()
    return Path(lowered).name in _ENTRY_NAMES or lowered in _ENTRY_PATHS


def _is_test_file(relative: str) -> bool:
    lowered = relative.casefold()
    path = Path(lowered)
    name = path.name
    in_test_directory = any(part in {"test", "tests"} for part in path.parts[:-1])
    return (
        in_test_directory
        or (name.startswith("test_") and name.endswith(".py"))
        or name.endswith("_test.py")
        or name.endswith(".test.ts")
        or name.endswith(".spec.ts")
    )


def generate_repo_map(
    workspace_root: Path,
    *,
    max_files: int = 2_000,
    scan_depth: int = 20,
) -> RepoMap:
    """生成不依赖遍历顺序、时间或平台路径分隔符的仓库地图。"""
    if max_files <= 0 or scan_depth <= 0:
        raise ValueError("max_files 和 scan_depth 必须大于 0")
    root = resolve_workspace_path(workspace_root, "", allow_root=True)
    files, depth_truncated = _discover_files(root, scan_depth)
    tree = files[:max_files]
    max_depth = max((len(Path(relative).parts) for relative in files), default=0)

    return RepoMap(
        root_name=root.name,
        total_files=len(files),
        languages=_language_counts(files),
        entry_files=[relative for relative in files if _is_entry_file(relative)],
        test_files=[relative for relative in files if _is_test_file(relative)],
        manifests=[
            relative for relative in files if Path(relative.casefold()).name in _MANIFEST_NAMES
        ],
        tree=tree,
        max_depth=max_depth,
        truncated=depth_truncated or len(files) > max_files,
    )
