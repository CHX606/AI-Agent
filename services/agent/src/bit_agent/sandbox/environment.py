"""Build dependency-only images before offline execution; never build project Dockerfiles."""

import asyncio
import hashlib
import json
import os
import tempfile
import tomllib
from pathlib import Path

from packaging.requirements import InvalidRequirement, Requirement

from bit_agent.security.paths import resolve_workspace_path

SYSTEM_PACKAGES = frozenset({"tesseract-ocr", "tesseract-ocr-chi-sim", "tesseract-ocr-eng"})
_locks: dict[tuple[asyncio.AbstractEventLoop, str], asyncio.Lock] = {}


class EnvironmentPreparationError(RuntimeError):
    """Dependencies could not be validated or installed."""


def dependency_spec(root: Path) -> tuple[list[str], list[str]]:
    """Read bounded, ordinary manifests; disallow URLs, local installs and pip options."""
    requirements: list[str] = []
    system: list[str] = []
    for filename in ("pyproject.toml", "requirements.txt", "requirements-dev.txt"):
        path = resolve_workspace_path(root, filename)
        if not path.exists():
            continue
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 128 * 1024:
            raise EnvironmentPreparationError(f"Invalid dependency manifest: {filename}")
        content = path.read_text(encoding="utf-8")
        if filename == "pyproject.toml":
            data = tomllib.loads(content)
            project = data.get("project", {})
            if "dependencies" in project.get("dynamic", []):
                raise EnvironmentPreparationError("Dynamic dependencies require a prepared image")
            requirements.extend(project.get("dependencies", []))
            extras = project.get("optional-dependencies", {})
            for group in ("dev", "test"):
                requirements.extend(extras.get(group, []))
            system = (
                data.get("tool", {})
                .get("bit-agent", {})
                .get("environment", {})
                .get("system-packages", [])
            )
        else:
            requirements.extend(
                line.strip()
                for line in content.splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            )
    if len(requirements) > 200 or not isinstance(system, list):
        raise EnvironmentPreparationError("Invalid dependency count or system package list")
    normalized = []
    for value in requirements:
        if not isinstance(value, str) or len(value) > 500 or any(c in value for c in "\r\n\\"):
            raise EnvironmentPreparationError("Invalid requirement")
        try:
            requirement = Requirement(value)
        except InvalidRequirement as exc:
            raise EnvironmentPreparationError(
                "Only named Python package requirements are allowed"
            ) from exc
        if requirement.url:
            raise EnvironmentPreparationError("URL, VCS and local dependencies are not allowed")
        normalized.append(str(requirement))
    if any(not isinstance(pkg, str) or pkg not in SYSTEM_PACKAGES for pkg in system):
        raise EnvironmentPreparationError(
            "System package is outside the permitted OCR package list"
        )
    return sorted(set(normalized)), sorted(set(system))


async def _command(*args: str, timeout: float = 300) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    output = bytearray()

    async def drain() -> None:
        assert process.stdout is not None
        while chunk := await process.stdout.read(4096):
            output.extend(chunk)
            if len(output) > 16_384:
                del output[:-16_384]
        await process.wait()

    try:
        await asyncio.wait_for(drain(), timeout)
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    return process.returncode or 0, output.decode("utf-8", errors="replace")


async def prepare_environment(root: Path, base_image: str, docker: str) -> str:
    """Cache by base image ID and normalized dependencies, rebuilding after manifest changes."""
    if os.getenv("BIT_AGENT_AUTO_ENVIRONMENT", "1") == "0":
        return base_image
    try:
        requirements, system = dependency_spec(root)
        if not requirements and not system:
            return base_image
        code, base_id = await _command(
            docker, "image", "inspect", "--format", "{{.Id}}", base_image
        )
        if code:
            raise EnvironmentPreparationError("Base sandbox image is unavailable")
        key = hashlib.sha256(
            json.dumps(["v1", base_id.strip(), requirements, system], sort_keys=True).encode()
        ).hexdigest()[:32]
        image = f"bit-agent-env:{key}"
        lock = _locks.setdefault((asyncio.get_running_loop(), image), asyncio.Lock())
        async with lock:
            code, _ = await _command(docker, "image", "inspect", image)
            if code == 0:
                return image
            pinned_base = f"bit-agent-env-base:{key}"
            code, _ = await _command(docker, "tag", base_id.strip(), pinned_base)
            if code:
                raise EnvironmentPreparationError("Cannot pin local base image")
            # Only generated manifests enter the networked build; no source or credentials.
            with tempfile.TemporaryDirectory(prefix="bit-agent-env-") as directory:
                context = Path(directory)
                lines = [f"FROM {pinned_base}", "USER root"]
                if system:
                    lines.append(
                        "RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' "
                        "/etc/apt/sources.list.d/debian.sources && "
                        "apt-get -o Acquire::Retries=3 update && "
                        "apt-get -o Acquire::Retries=3 install -y --no-install-recommends "
                        + " ".join(system)
                        + " && rm -rf /var/lib/apt/lists/*"
                    )
                if requirements:
                    (context / "requirements.txt").write_text(
                        "\n".join(requirements) + "\n", encoding="utf-8"
                    )
                    lines.extend(
                        [
                            "COPY requirements.txt /opt/bit-agent/environment-requirements.txt",
                            "RUN python -m pip --isolated install --no-cache-dir "
                            "--only-binary=:all: --index-url https://pypi.org/simple "
                            "-r /opt/bit-agent/environment-requirements.txt",
                        ]
                    )
                lines.extend(["USER sandbox:sandbox", "WORKDIR /workspace"])
                (context / "Dockerfile").write_text("\n".join(lines) + "\n", encoding="utf-8")
                code, output = await _command(docker, "build", "-t", image, str(context))
                if code:
                    raise EnvironmentPreparationError(f"Dependency image build failed:\n{output}")
            return image
    except (OSError, ValueError, TypeError, AttributeError, TimeoutError) as exc:
        raise EnvironmentPreparationError(
            f"Environment preparation failed ({type(exc).__name__}): {exc}"
        ) from exc
