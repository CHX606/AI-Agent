from pathlib import Path

from bit_agent.context import generate_repo_map


def write_file(root: Path, relative: str, content: str = "") -> None:
    target = root.joinpath(*relative.split("/"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def test_repo_map_discovers_tree_languages_and_candidates(tmp_path: Path) -> None:
    write_file(tmp_path, "src/main.py")
    write_file(tmp_path, "src/ui.tsx")
    write_file(tmp_path, "src/helpers.js")
    write_file(tmp_path, "tests/test_main.py")
    write_file(tmp_path, "web/widget.spec.ts")
    write_file(tmp_path, "pyproject.toml")
    write_file(tmp_path, "package.json")
    write_file(tmp_path, "README.md")
    write_file(tmp_path, "config.yaml")

    repo_map = generate_repo_map(tmp_path)

    assert repo_map.root_name == tmp_path.name
    assert repo_map.total_files == 9
    assert repo_map.languages == {
        "Python": 2,
        "TypeScript": 2,
        "JavaScript": 1,
        "Markdown": 1,
        "JSON": 1,
        "YAML": 1,
    }
    assert repo_map.entry_files == ["package.json", "pyproject.toml", "src/main.py"]
    assert repo_map.test_files == ["tests/test_main.py", "web/widget.spec.ts"]
    assert repo_map.manifests == ["package.json", "pyproject.toml"]
    assert repo_map.tree == sorted(repo_map.tree)
    assert all("\\" not in relative for relative in repo_map.tree)
    assert repo_map.max_depth == 2
    assert not repo_map.truncated


def test_repo_map_ignores_generated_and_protected_paths(tmp_path: Path) -> None:
    write_file(tmp_path, "src/app.py")
    for directory in (
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
    ):
        write_file(tmp_path, f"{directory}/ignored.py")
    write_file(tmp_path, ".env", "SECRET=value")
    write_file(tmp_path, "keys/private.pem", "secret")

    repo_map = generate_repo_map(tmp_path)

    assert repo_map.tree == ["src/app.py"]
    assert repo_map.total_files == 1


def test_repo_map_truncates_tree_but_counts_all_discovered_files(tmp_path: Path) -> None:
    for index in range(5):
        write_file(tmp_path, f"src/file_{index}.py")

    repo_map = generate_repo_map(tmp_path, max_files=3)

    assert repo_map.total_files == 5
    assert repo_map.languages == {"Python": 5}
    assert repo_map.tree == ["src/file_0.py", "src/file_1.py", "src/file_2.py"]
    assert repo_map.truncated


def test_repo_map_marks_depth_truncation(tmp_path: Path) -> None:
    write_file(tmp_path, "top.py")
    write_file(tmp_path, "one/two/deep.py")

    repo_map = generate_repo_map(tmp_path, scan_depth=1)

    assert repo_map.tree == ["top.py"]
    assert repo_map.truncated


def test_repo_map_json_is_identical_across_runs(tmp_path: Path) -> None:
    write_file(tmp_path, "zeta.py")
    write_file(tmp_path, "alpha.ts")
    write_file(tmp_path, "tests/test_zeta.py")

    first = generate_repo_map(tmp_path).model_dump_json()
    second = generate_repo_map(tmp_path).model_dump_json()

    assert first == second
