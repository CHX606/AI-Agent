"""Dependency preparation validation, cache invalidation and network boundary."""

import asyncio
from pathlib import Path

import pytest
from bit_agent.sandbox import environment as env


@pytest.mark.parametrize(
    "requirement",
    [
        "-r other.txt",
        "--index-url https://evil.test",
        "pkg @ https://evil.test/a.whl",
        "git+https://evil.test/repo",
        "../local",
        "-e .",
    ],
)
def test_rejects_dependency_escape(tmp_path: Path, requirement: str) -> None:
    (tmp_path / "requirements.txt").write_text(requirement)
    with pytest.raises(env.EnvironmentPreparationError):
        env.dependency_spec(tmp_path)


def test_reads_project_extras_and_system_packages(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        '[project]\ndependencies=["httpx>=0.26"]\n'
        '[project.optional-dependencies]\ntest=["pytest"]\n'
        '[tool.bit-agent.environment]\nsystem-packages=["tesseract-ocr"]\n'
    )
    assert env.dependency_spec(tmp_path) == (["httpx>=0.26", "pytest"], ["tesseract-ocr"])


async def test_cache_reuse_and_dependency_change(tmp_path: Path, monkeypatch) -> None:
    manifest = tmp_path / "requirements.txt"
    manifest.write_text("httpx==0.28.1")
    (tmp_path / ".env").write_text("SECRET=not-for-builder")
    images = set()
    builds = []

    async def command(*args, **kwargs):
        if "--format" in args:
            return 0, "sha256:" + "a" * 64
        if args[1:3] == ("image", "inspect"):
            return (0, "") if args[-1] in images else (1, "missing")
        if args[1] == "tag":
            return 0, ""
        assert args[1] == "build"
        context = Path(args[-1])
        assert {p.name for p in context.iterdir()} == {"Dockerfile", "requirements.txt"}
        dockerfile = (context / "Dockerfile").read_text()
        assert "--only-binary=:all:" in dockerfile
        assert "USER sandbox:sandbox" in dockerfile
        builds.append(args[3])
        images.add(args[3])
        return 0, "built"

    monkeypatch.setattr(env, "_command", command)
    first = await env.prepare_environment(tmp_path, "base", "docker")
    assert await env.prepare_environment(tmp_path, "base", "docker") == first
    assert len(builds) == 1
    manifest.write_text("httpx==0.27.0")
    assert await env.prepare_environment(tmp_path, "base", "docker") != first
    assert len(builds) == 2


async def test_concurrent_preparation_builds_once(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "requirements.txt").write_text("httpx")
    built = False
    count = 0

    async def command(*args, **kwargs):
        nonlocal built, count
        if "--format" in args:
            return 0, "sha256:" + "b" * 64
        if args[1] == "tag":
            return 0, ""
        if args[1] == "build":
            count += 1
            await asyncio.sleep(0.01)
            built = True
            return 0, ""
        return (0, "") if built else (1, "")

    monkeypatch.setattr(env, "_command", command)
    images = await asyncio.gather(
        *(env.prepare_environment(tmp_path, "base", "docker") for _ in range(3))
    )
    assert len(set(images)) == 1
    assert count == 1


def test_rejects_unapproved_system_packages(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        '[tool.bit-agent.environment]\nsystem-packages=["curl; echo injected"]'
    )
    with pytest.raises(env.EnvironmentPreparationError, match="permitted OCR"):
        env.dependency_spec(tmp_path)


async def test_build_failure_is_returned(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "requirements.txt").write_text("httpx")

    async def command(*args, **kwargs):
        if "--format" in args:
            return 0, "sha256:" + "a" * 64
        if args[1] == "tag":
            return 0, ""
        return 1, "package download failed"

    monkeypatch.setattr(env, "_command", command)
    with pytest.raises(env.EnvironmentPreparationError, match="package download failed"):
        await env.prepare_environment(tmp_path, "base", "docker")
