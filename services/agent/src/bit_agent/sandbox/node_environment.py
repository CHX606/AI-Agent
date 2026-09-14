"""前端依赖在单独镜像里安装，项目源码不进入联网安装阶段。"""

import hashlib
import json
import re
import tempfile
from pathlib import Path

from bit_agent.sandbox.environment import EnvironmentPreparationError, _command


def node_manifest(root: Path) -> tuple[dict, str, str | None]:
    manifest_path = root / "package.json"
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 128 * 1024:
        raise EnvironmentPreparationError("package.json 必须是 128 KB 以内的普通文件")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise EnvironmentPreparationError("package.json 必须是对象")
    if manifest.get("workspaces") or (root / "pnpm-workspace.yaml").exists():
        raise EnvironmentPreparationError("多包工作区需要单独准备验证镜像，不能当成单包项目通过")
    manager = manifest.get("packageManager", "npm")
    if manager == "npm" or re.fullmatch(r"npm@\d+\.\d+\.\d+", manager):
        return manifest, "npm", manager.split("@", 1)[1] if "@" in manager else None
    match = re.fullmatch(r"pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:256|512)\.[a-f0-9]+)?", manager)
    if match:
        return manifest, "pnpm", match[1]
    if (root / "pnpm-lock.yaml").exists():
        raise EnvironmentPreparationError("请在 packageManager 写明 pnpm 的具体版本")
    raise EnvironmentPreparationError("目前自动验证支持 npm 和指定版本的 pnpm")


async def prepare_node_environment(root: Path, docker: str = "docker") -> str:
    manifest, manager, version = node_manifest(root)
    dependencies: dict[str, str] = {}
    for field in ("dependencies", "devDependencies", "optionalDependencies"):
        values = manifest.get(field, {})
        if not isinstance(values, dict):
            raise EnvironmentPreparationError("依赖列表必须是对象")
        for name, spec in values.items():
            if (
                not re.fullmatch(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+", name)
                or not isinstance(spec, str)
                or len(spec) > 100
                or not re.fullmatch(r"[0-9A-Za-z^~<>=.*| +_-]+", spec)
            ):
                raise EnvironmentPreparationError("自动环境只安装公开仓库中的普通版本依赖")
            dependencies[name] = spec
    if len(dependencies) > 300:
        raise EnvironmentPreparationError("依赖过多，请提供准备好的验证环境")
    clean = {
        "name": "bit-agent-check",
        "version": "1.0.0",
        "private": True,
        "dependencies": dependencies,
    }
    # 故意不复制 .npmrc、安装脚本和源码。锁文件暂不重放，结果会明确说明这一点。
    key = hashlib.sha256(
        json.dumps([clean, manager, version], sort_keys=True).encode()
    ).hexdigest()[:32]
    image = f"bit-agent-node:{key}"
    code, _ = await _command(docker, "image", "inspect", image)
    if code == 0:
        return image
    with tempfile.TemporaryDirectory(prefix="bit-agent-node-") as directory:
        target = Path(directory)
        (target / "package.json").write_text(json.dumps(clean), encoding="utf-8")
        lines = ["FROM node:24-bookworm-slim", "WORKDIR /opt/bit-agent", "COPY package.json ./"]
        if version:
            lines.append(f"RUN npm install --global --ignore-scripts {manager}@{version}")
        lines.append(
            f"RUN {manager} install --ignore-scripts --registry=https://registry.npmjs.org"
        )
        lines.extend(["ENV CI=1", "USER 10001:10001", "WORKDIR /workspace"])
        (target / "Dockerfile").write_text("\n".join(lines) + "\n", encoding="utf-8")
        code, output = await _command(docker, "build", "-t", image, directory, timeout=600)
        if code:
            raise EnvironmentPreparationError("前端依赖环境准备失败：" + output)
    return image
