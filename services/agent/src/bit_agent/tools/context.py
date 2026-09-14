"""由可信 Worker 构造并注入工具的执行上下文。"""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class ToolContext:
    workspace_root: Path
    tool_call_id: str
    timeout_seconds: float = 5.0  # 一次调用最多运行几秒。
    max_output_bytes: int = 64 * 1024  # 一次调用最多返回多少字节的输出。
    max_results: int = 200  # 一次调用最多返回多少条结果。
    max_depth: int = 5  # 一次调用最多支持多少层嵌套。
    max_read_lines: int = 500  # 一次调用最多读取多少行。
    max_patch_bytes: int = 256 * 1024  # 单次补丁最大字节数。
    max_patch_files: int = 20  # 单次补丁最多修改多少个文件。
    task_id: str = "task"  # 由 Worker 提供，用于关联沙箱容器。

    def __post_init__(self) -> None:
        root = self.workspace_root.resolve()
        if not root.is_dir():
            raise ValueError("workspace_root 必须是已存在的目录")
        if not self.tool_call_id.strip():
            raise ValueError("tool_call_id 不能为空")
        if not self.task_id.strip():
            raise ValueError("task_id 不能为空")
        for name in (
            "timeout_seconds",
            "max_output_bytes",
            "max_results",
            "max_depth",
            "max_read_lines",
            "max_patch_bytes",
            "max_patch_files",
        ):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} 必须大于 0")
        object.__setattr__(self, "workspace_root", root)
