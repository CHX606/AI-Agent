"""从环境变量构造独立于聊天模型的 Embedding Provider。"""

import os
from collections.abc import Mapping
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field, field_validator

from bit_agent.memory.embedding import OpenAIEmbeddingProvider


class EmbeddingSettings(BaseModel):
    """Embedding 服务的稳定配置与向量空间身份。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    api_key: str = Field(min_length=1)
    base_url: str = Field(min_length=1)
    model: str = Field(min_length=1)
    dimensions: int = Field(default=512, gt=0, le=65_535)
    provider_name: str = Field(default="openai-compatible", min_length=1)
    version: str = Field(default="1", min_length=1)
    request_timeout_seconds: float = Field(default=30.0, gt=0)
    max_retries: int = Field(default=1, ge=0, le=10)

    @field_validator("api_key", "base_url", "model", "provider_name", "version")
    @classmethod
    def strip_non_empty_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Embedding 配置不能为空")
        return normalized

    @field_validator("base_url")
    @classmethod
    def normalize_base_url(cls, value: str) -> str:
        if not value.startswith(("http://", "https://")):
            raise ValueError("EMBEDDING_BASE_URL 必须使用 http:// 或 https://")
        return value.rstrip("/")

    @classmethod
    def from_environment(
        cls,
        environment: Mapping[str, str] | None = None,
    ) -> "EmbeddingSettings":
        """读取 EMBEDDING_*，不复用聊天模型的 API_KEY/BASE_URL。"""
        if environment is None:
            load_dotenv()
            environment = os.environ

        def required(name: str) -> str:
            value = environment.get(name)
            if not value or not value.strip():
                raise RuntimeError(f"缺少环境变量：{name}")
            return value

        return cls(
            api_key=required("EMBEDDING_API_KEY"),
            base_url=required("EMBEDDING_BASE_URL"),
            model=required("EMBEDDING_MODEL"),
            dimensions=environment.get("EMBEDDING_DIMENSIONS", "512"),
            provider_name=environment.get(
                "EMBEDDING_PROVIDER",
                "openai-compatible",
            ),
            version=environment.get("EMBEDDING_VERSION", "1"),
            request_timeout_seconds=environment.get(
                "EMBEDDING_TIMEOUT_SECONDS",
                "30",
            ),
            max_retries=environment.get("EMBEDDING_MAX_RETRIES", "1"),
        )

    def create_client(self) -> Any:
        """创建只服务于向量请求的 OpenAI 兼容客户端。"""
        return OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=self.request_timeout_seconds,
            max_retries=self.max_retries,
        )

    def create_provider(self) -> OpenAIEmbeddingProvider:
        """创建包含 Embedding Profile 信息的 Provider。"""
        return OpenAIEmbeddingProvider(
            self.create_client(),
            self.model,
            dimensions=self.dimensions,
            request_timeout_seconds=self.request_timeout_seconds,
            provider_name=self.provider_name,
            version=self.version,
        )


def embedding_provider_from_environment() -> OpenAIEmbeddingProvider:
    """供 Agent/Eval 入口直接使用的默认工厂。"""
    return EmbeddingSettings.from_environment().create_provider()
