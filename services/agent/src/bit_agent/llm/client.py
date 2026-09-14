"""每轮读取当前模型配置；没有配置时也能启动应用、查看历史和打开设置。"""

from functools import lru_cache
from os import getenv

from dotenv import load_dotenv
from openai import OpenAI

from bit_agent.observability.model import DiagnosticSyncHttpClient

load_dotenv()


@lru_cache(maxsize=8)
def _client(api_key: str, base_url: str) -> OpenAI:
    return OpenAI(api_key=api_key, base_url=base_url, http_client=DiagnosticSyncHttpClient())


def get_configuration() -> tuple[OpenAI, str]:
    values = [getenv(name, "") for name in ("API_KEY", "BASE_URL", "MODEL_NAME")]
    if not all(values):
        raise RuntimeError("请先在模型设置中填写地址、模型名和 API Key")
    return _client(values[0], values[1]), values[2]


def __getattr__(name: str):
    if name == "client":
        return get_configuration()[0]
    if name == "model_name":
        return get_configuration()[1]
    raise AttributeError(name)
