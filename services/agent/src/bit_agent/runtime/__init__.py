"""项目内部的调用入口。Gateway 不需要了解模型、记忆和工具的具体实现。"""

from bit_agent.runtime.application.service import AgentRuntime
from bit_agent.runtime.bootstrap import create_runtime

__all__ = ["AgentRuntime", "create_runtime"]
