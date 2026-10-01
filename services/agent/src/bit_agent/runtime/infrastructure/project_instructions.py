"""读取项目自己写给 Agent 的说明：代码约定、常用命令、注意事项。"""

from pathlib import Path

# AGENTS.md 是多种编码 Agent 通用的约定；.bit-agent/instructions.md 只给 Bit Agent 看。
INSTRUCTION_FILES = ("AGENTS.md", ".bit-agent/instructions.md")
# 两个文件合计的上限，约 4000～5000 tokens，避免挤占任务本身的上下文。
MAX_TOTAL_BYTES = 16 * 1024


def read_project_instructions(root: Path) -> dict | None:
    """返回 {"paths": [...], "text": "...", "truncated": bool}；没有说明文件时返回 None。"""
    parts: list[str] = []
    paths: list[str] = []
    remaining = MAX_TOTAL_BYTES
    truncated = False
    for name in INSTRUCTION_FILES:
        path = root / name
        try:
            if path.is_symlink() or not path.is_file():
                continue
            if remaining <= 0:
                truncated = True
                break
            with path.open("rb") as stream:
                data = stream.read(remaining + 1)
        except OSError:
            continue
        if len(data) > remaining:
            data, truncated = data[:remaining], True
        text = data.decode("utf-8", errors="ignore").strip()
        if not text:
            continue
        paths.append(name)
        parts.append(f"## {name}\n\n{text}")
        remaining -= len(data)
    if not parts:
        return None
    return {"paths": paths, "text": "\n\n".join(parts), "truncated": truncated}
