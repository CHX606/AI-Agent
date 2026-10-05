"""读取项目已有 Node 包管理器和验证脚本，不安装或准备依赖。"""

import json
import re
from pathlib import Path


class ProjectEnvironmentError(ValueError):
    """项目现有工具链或验证脚本不足以运行检查。"""


def node_manifest(root: Path) -> tuple[dict, str, str | None]:
    manifest_path = root / "package.json"
    try:
        if (
            manifest_path.is_symlink()
            or not manifest_path.is_file()
            or manifest_path.stat().st_size > 128 * 1024
        ):
            raise ProjectEnvironmentError("package.json 必须是 128 KB 以内的普通文件")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProjectEnvironmentError(f"package.json 无法读取：{exc}") from exc
    if not isinstance(manifest, dict):
        raise ProjectEnvironmentError("package.json 必须是对象")
    if manifest.get("workspaces") or (root / "pnpm-workspace.yaml").exists():
        raise ProjectEnvironmentError("多包工作区需要在 .bit-agent/verify.json 中配置验证命令")
    manager = manifest.get("packageManager", "npm")
    if not isinstance(manager, str):
        raise ProjectEnvironmentError("packageManager 必须是字符串")
    if manager == "npm" or re.fullmatch(r"npm@\d+\.\d+\.\d+", manager):
        return manifest, "npm", manager.split("@", 1)[1] if "@" in manager else None
    match = re.fullmatch(r"pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:256|512)\.[a-f0-9]+)?", manager)
    if match:
        return manifest, "pnpm", match[1]
    if (root / "pnpm-lock.yaml").exists():
        raise ProjectEnvironmentError("请在 packageManager 写明 pnpm 的具体版本")
    raise ProjectEnvironmentError("目前自动验证支持 npm 和指定版本的 pnpm")
