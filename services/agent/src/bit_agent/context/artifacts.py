"""把不适合反复随模型请求发送的大型工具结果另存为文件，在输入上下文里保留较短的预览和引用信息"""

import hashlib
import re
from pathlib import Path

from bit_agent.context.models import ContextArtifact
from bit_agent.memory.budget import estimate_tokens

_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+") #用于安全地清理文件名


class FileContextArtifactStore:
    """在 Harness 的运行目录中以不可覆盖的文件保存工具原文。"""

    def __init__(self, root: Path) -> None: #初始化文件上下文工件存储
        self.root = root.resolve()

    def save(self, tool_call_id: str, content: str) -> ContextArtifact: #保存工具调用的原始内容为文件，并返回 ContextArtifact 对象
        if not tool_call_id.strip():
            raise ValueError("tool_call_id 不能为空")
        if not content:
            raise ValueError("Artifact 内容不能为空")

        digest = hashlib.sha256(content.encode("utf-8")).hexdigest() #计算内容的 SHA256 哈希值
        safe_call_id = _SAFE_NAME.sub("_", tool_call_id).strip("._") or "tool-call" #清理 tool_call_id 以生成安全的文件名
        file_name = f"{safe_call_id[:80]}-{digest[:12]}.txt"
        self.root.mkdir(parents=True, exist_ok=True) #确保根目录存在
        path = (self.root / file_name).resolve()
        if path.parent != self.root:
            raise ValueError("Artifact 路径越过运行目录")
        if path.exists(): #如果文件已存在，检查内容是否一致
            if path.read_text(encoding="utf-8") != content:
                raise RuntimeError("Artifact 哈希路径与已有内容冲突")
        else:
            path.write_text(content, encoding="utf-8")

        return ContextArtifact( #返回 ContextArtifact 对象
            tool_call_id=tool_call_id,
            path=str(path),
            sha256=digest,
            original_tokens=estimate_tokens(content),
            original_characters=len(content),
        )
