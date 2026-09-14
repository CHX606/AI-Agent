"""Embedding 专用环境配置测试。"""

from types import SimpleNamespace

import bit_agent.memory.config as embedding_config
import pytest
from bit_agent.memory import EmbeddingSettings
from pydantic import ValidationError


def ollama_environment() -> dict[str, str]:
    return {
        "EMBEDDING_API_KEY": "ollama",
        "EMBEDDING_BASE_URL": "http://localhost:11434/v1/",
        "EMBEDDING_MODEL": "qwen3-embedding:0.6b",
        "EMBEDDING_DIMENSIONS": "512",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_VERSION": "1",
    }


def test_embedding_settings_are_isolated_from_chat_configuration() -> None:
    settings = EmbeddingSettings.from_environment(ollama_environment())

    assert settings.base_url == "http://localhost:11434/v1"
    assert settings.model == "qwen3-embedding:0.6b"
    assert settings.dimensions == 512
    assert settings.provider_name == "ollama"


def test_embedding_settings_reject_missing_or_invalid_values() -> None:
    with pytest.raises(RuntimeError, match="EMBEDDING_API_KEY"):
        EmbeddingSettings.from_environment({})

    invalid = ollama_environment()
    invalid["EMBEDDING_DIMENSIONS"] = "zero"
    with pytest.raises(ValidationError):
        EmbeddingSettings.from_environment(invalid)


def test_settings_create_profile_aware_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_openai(**kwargs: object) -> SimpleNamespace:
        captured.update(kwargs)
        return SimpleNamespace()

    monkeypatch.setattr(embedding_config, "OpenAI", fake_openai)
    provider = EmbeddingSettings.from_environment(
        ollama_environment()
    ).create_provider()

    assert captured["api_key"] == "ollama"
    assert captured["base_url"] == "http://localhost:11434/v1"
    assert provider.model == "qwen3-embedding:0.6b"
    assert provider.dimensions == 512
    assert provider.provider_name == "ollama"
