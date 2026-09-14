"""记录每次实际改动。撤销前对照内容，用户后来改过的文件绝不覆盖。"""

import base64
import difflib
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path
from uuid import uuid4

from bit_agent.observability.diagnostics import failure
from bit_agent.runtime.domain.errors import InteractionError
from bit_agent.security.paths import resolve_workspace_path
from bit_agent.tools.apply_patch import _normalize_supported_patch, _parse_affected_paths
from bit_agent.tools.context import ToolContext

MAX_FILE_BYTES = 4 * 1024 * 1024


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception as exc:
        failure("file_save_failed", exc, operation="change_journal")
        raise
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError as exc:
            failure("file_cleanup_failed", exc, level="warn", operation="change_journal")


def file_image(root: Path, name: str) -> dict:
    # 检查原始路径的每一级，不能借助链接改到另一个位置。
    path = resolve_workspace_path(root, name)
    original = root / name
    for part in (original, *original.parents):
        if part == root:
            break
        if part.is_symlink() or part.is_junction():
            raise ValueError("改动审阅不接受符号链接或目录联接")
    if not path.exists():
        return {"content": None, "hash": None, "mode": None}
    info = path.stat()
    if not path.is_file() or info.st_size > MAX_FILE_BYTES or info.st_nlink > 1:
        raise ValueError("只允许修改 4 MB 以内、没有硬链接的普通文件")
    content = path.read_bytes()
    if len(content) > MAX_FILE_BYTES:
        raise ValueError("文件过大")
    return {
        "content": base64.b64encode(content).decode("ascii"),
        "hash": hashlib.sha256(content).hexdigest(),
        "mode": stat.S_IMODE(info.st_mode),
    }


class ChangeJournal:
    def __init__(self, root: Path, directory: Path) -> None:
        self.root = root.resolve()
        self.directory = directory
        self.path = directory / "changes.json"
        self.entries: list[dict] = (
            json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else []
        )

    def prepare(self, call_id: str, patch: str) -> dict:
        if not isinstance(patch, str) or len(patch.encode()) > 256 * 1024:
            raise ValueError("补丁必须小于 256 KB")
        normalized = _normalize_supported_patch(ToolContext(self.root, call_id), patch)
        names = _parse_affected_paths(normalized)
        if not names or len(names) > 20 or len(self.entries) >= 100:
            raise ValueError("本次改动文件数或本轮改动次数超出限制")
        return {
            "id": uuid4().hex,
            "call_id": call_id,
            "status": "pending",
            "patch": normalized,
            "patch_hash": hashlib.sha256(patch.encode()).hexdigest(),
            "files": {name: {"before": file_image(self.root, name)} for name in names},
        }

    def begin(self, entry: dict) -> None:
        for name, record in entry["files"].items():
            if file_image(self.root, name) != record["before"]:
                raise InteractionError(f"等待期间文件已变化，请重新生成补丁：{name}")
        self.entries.append(entry)
        write_json(self.path, self.entries)

    def finish(self, entry: dict) -> None:
        for name, record in entry["files"].items():
            record["after"] = file_image(self.root, name)
        entry["status"] = "unreviewed"
        write_json(self.path, self.entries)

    def public(self) -> dict:
        result = []
        for entry in self.entries:
            files = []
            for name, record in entry["files"].items():
                before, after = record["before"], record.get("after")
                if after is not None and before == after:
                    continue

                def lines(image: dict) -> list[str]:
                    return (
                        base64.b64decode(image["content"] or "")
                        .decode("utf-8", errors="replace")
                        .splitlines(keepends=True)
                    )

                diff = (
                    "".join(
                        difflib.unified_diff(
                            lines(before),
                            lines(after),
                            fromfile="before/" + name,
                            tofile="after/" + name,
                        )
                    )
                    if after is not None
                    else "执行被中断，缺少完成快照。请手动核对，不提供自动撤销。"
                )
                files.append(
                    {
                        "path": name,
                        "diff": diff[:128_000],
                        "truncated": len(diff) > 128_000,
                        "undone": record.get("undone", False),
                    }
                )
            if files:
                result.append({"id": entry["id"], "status": entry["status"], "files": files})
        return {"changes": result}

    def review(self, change_id: str, action: str) -> dict:
        entry = next((item for item in self.entries if item["id"] == change_id), None)
        if entry is None:
            raise InteractionError("改动记录不存在", 404)
        if action not in {"accept", "undo"}:
            raise InteractionError("只支持保留或撤销", 400)
        if entry["status"] == "pending":
            raise InteractionError("这次改动缺少完成快照，需要手动检查")
        if entry["status"] == "undone":
            return self.public()
        if action == "accept":
            entry["status"] = "accepted"
            write_json(self.path, self.entries)
            return self.public()
        for name, record in entry["files"].items():
            if not record.get("undone") and file_image(self.root, name) != record["after"]:
                raise InteractionError(f"文件后来已被修改，拒绝覆盖：{name}。请先撤销较新的改动。")
        for name, record in entry["files"].items():
            if record.get("undone"):
                continue
            # 写入前再核对一次，尽量缩小与外部编辑器同时写入的时间窗口。
            if file_image(self.root, name) != record["after"]:
                raise InteractionError(f"撤销期间文件发生变化：{name}")
            target = resolve_workspace_path(self.root, name)
            before = record["before"]
            if before["content"] is None:
                target.unlink(missing_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                fd, temporary = tempfile.mkstemp(prefix=".bit-agent-undo-", dir=target.parent)
                try:
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(base64.b64decode(before["content"]))
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.chmod(temporary, before["mode"])
                    os.replace(temporary, target)
                finally:
                    Path(temporary).unlink(missing_ok=True)
            record["undone"] = True
            write_json(self.path, self.entries)
        entry["status"] = "undone"
        write_json(self.path, self.entries)
        return self.public()
