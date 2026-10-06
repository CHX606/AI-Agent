from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from bit_agent.runtime.application.interaction import (
    InteractionError,
)
from bit_agent.tool_provider.external import (
    ExternalMcpTools,
    ExternalServerConfigError,
    build_servers,
    validate_servers,
)


class ModelCommands:
    @staticmethod
    def _model_input(input: dict[str, Any], *, allow_auto: bool) -> tuple[str, str, str, str]:
        from urllib.parse import urlparse

        url = input.get("base_url", "")
        model = input.get("model", "")
        key = input.get("api_key", "")
        api = input.get("api", "responses")
        if not all(isinstance(value, str) and value.strip() for value in (url, model, key)):
            raise ValueError("模型地址、模型名和密钥不能为空")
        allowed = {"responses", "chat_completions", *({"auto"} if allow_auto else set())}
        if api not in allowed:
            raise ValueError("接口类型只能是 " + "、".join(sorted(allowed)))
        parsed = urlparse(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("模型地址不能夹带用户名、密钥或查询参数")
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError("远程模型必须使用 HTTPS，本地模型允许 HTTP")
        return url, model, key, api

    async def configure_model(self, input: dict[str, Any]) -> dict[str, Any]:
        url, model, key, api = self._model_input(input, allow_auto=False)
        auxiliary = input.get("aux_model") or ""
        if not isinstance(auxiliary, str) or len(auxiliary.strip()) > 200:
            raise ValueError("辅助模型名称最多 200 个字符")
        os.environ.update(
            API_KEY=key,
            BASE_URL=url,
            MODEL_NAME=model,
            MODEL_API=api,
            AUX_MODEL_NAME=auxiliary.strip(),
        )
        return {
            "configured": True,
            "model": model,
            "base_url": url,
            "api": api,
            "aux_model": auxiliary.strip() or None,
        }

    async def configure_mcp(self, servers: list[dict[str, Any]]) -> dict[str, Any]:
        """替换外部工具配置；从下一轮任务开始生效。"""
        try:
            self.mcp_servers = validate_servers(servers)
        except ExternalServerConfigError as exc:
            raise InteractionError(str(exc), 400) from exc
        return {
            "configured": len(self.mcp_servers),
            "enabled": sum(1 for server in self.mcp_servers if server["enabled"]),
        }

    async def test_mcp(self, server: dict[str, Any]) -> dict[str, Any]:
        """连接一个服务并列出它的工具，不调用任何工具。stdio 命令在用户目录下运行。"""
        try:
            config = validate_servers([{**server, "enabled": True}])
        except ExternalServerConfigError as exc:
            raise InteractionError(str(exc), 400) from exc
        tools = ExternalMcpTools(build_servers(config, Path.home()))
        async with tools:
            if tools.failed:
                return {"ok": False, "tools": [], "message": tools.failed[0]["error"]}
            return {
                "ok": True,
                "tools": [tools.original_name(item["name"]) for item in tools.model_tools()],
                "message": f"连接成功，共 {len(tools.model_tools())} 个工具",
            }

    async def test_model(self, input: dict[str, Any]) -> dict[str, Any]:
        """真实请求一次模型；不修改当前生效的配置。"""
        from bit_agent.llm.probe import probe_model

        url, model, key, api = self._model_input(input, allow_auto=True)
        return await probe_model(url, model, key, api)
