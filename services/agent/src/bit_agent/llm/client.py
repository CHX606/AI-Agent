"""每轮读取当前模型配置；没有配置时也能启动应用、查看历史和打开设置。"""

from functools import lru_cache
from os import getenv

from dotenv import load_dotenv
from openai import OpenAI, Timeout

from bit_agent.observability.model import DiagnosticSyncHttpClient

load_dotenv()

# Responses：OpenAI 官方等支持 /v1/responses 的服务；
# Chat Completions：只提供 /v1/chat/completions 的兼容服务（多数国内服务商和本地推理服务）。
MODEL_APIS = ("responses", "chat_completions")
# SDK 默认建立连接只等 5 秒、重试 2 次；经代理或访问海外服务时经常不够。
DEFAULT_CONNECT_TIMEOUT_SECONDS = 20.0
DEFAULT_MAX_RETRIES = 4


def _number(name: str, default: float, low: float, high: float) -> float:
    try:
        value = float(getenv(name, "") or default)
    except ValueError:
        return default
    return min(max(value, low), high)


def model_timeout() -> Timeout:
    """读取回答最多 10 分钟；建立连接默认 20 秒，可用 MODEL_CONNECT_TIMEOUT_SECONDS 调整。"""
    connect = _number("MODEL_CONNECT_TIMEOUT_SECONDS", DEFAULT_CONNECT_TIMEOUT_SECONDS, 1, 120)
    return Timeout(600.0, connect=connect)


def model_max_retries() -> int:
    """连接失败、超时、429 和 5xx 时的重试次数，默认 4，可用 MODEL_MAX_RETRIES 调整。"""
    return int(_number("MODEL_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0, 10))


@lru_cache(maxsize=8)
def _cached_client(api_key: str, base_url: str, connect_timeout: float, max_retries: int) -> OpenAI:
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=Timeout(600.0, connect=connect_timeout),
        max_retries=max_retries,
        http_client=DiagnosticSyncHttpClient(),
    )


def _client(api_key: str, base_url: str) -> OpenAI:
    return _cached_client(api_key, base_url, model_timeout().connect, model_max_retries())


def get_configuration() -> tuple[OpenAI, str]:
    values = [getenv(name, "") for name in ("API_KEY", "BASE_URL", "MODEL_NAME")]
    if not all(values):
        raise RuntimeError("请先在模型设置中填写地址、模型名和 API Key")
    return _client(values[0], values[1]), values[2]


AUX_MODEL_ENV = "AUX_MODEL_NAME"


def auxiliary_model_name() -> str:
    """调查子 Agent、上下文摘要、记忆提炼和提交信息用的模型。

    同一个接口地址和密钥下的另一个（通常更便宜的）模型；没有设置时用主模型。
    """
    return getenv(AUX_MODEL_ENV, "").strip() or get_configuration()[1]


def model_api() -> str:
    """当前配置使用的接口类型；未设置或无法识别时沿用 Responses。"""
    value = getenv("MODEL_API", "responses").strip().casefold()
    return value if value in MODEL_APIS else "responses"


def __getattr__(name: str):
    if name == "client":
        return get_configuration()[0]
    if name == "model_name":
        return get_configuration()[1]
    raise AttributeError(name)
