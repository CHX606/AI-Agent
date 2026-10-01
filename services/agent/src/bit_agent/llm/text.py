"""不需要工具的单轮文本请求（摘要、记忆提炼），按配置选择 Responses 或 Chat Completions。"""

from typing import Any

from bit_agent.llm.client import model_api
from bit_agent.observability.usage import record_usage


def create_text(
    client: Any,
    *,
    model: str,
    instructions: str,
    content: str,
    timeout: float,
    api: str | None = None,
) -> str:
    """同步调用（调用方放进线程）；返回模型输出的纯文本。用量记为辅助请求。"""
    if (api or model_api()) == "chat_completions" and hasattr(client, "chat"):
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": instructions},
                {"role": "user", "content": content},
            ],
            timeout=timeout,
        )
        record_usage("auxiliary", getattr(response, "usage", None))
        return response.choices[0].message.content or ""
    response = client.responses.create(
        model=model,
        input=[
            {"role": "developer", "content": instructions},
            {"role": "user", "content": content},
        ],
        timeout=timeout,
    )
    record_usage("auxiliary", getattr(response, "usage", None))
    return response.output_text
