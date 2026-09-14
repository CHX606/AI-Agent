"""只替换模型的回答，不替换 SDK Runner，因此测试仍经过真正的 SDK 工具循环。"""

import asyncio
from uuid import uuid4

import pytest
from agents import Model
from agents.items import ModelResponse
from agents.usage import Usage
from bit_agent.agent import runtime
from bit_agent.context.serialization import to_json_value
from openai import AsyncOpenAI, OpenAI
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)


class FixtureModel(Model):
    """把现有测试数据接到 SDK 的 Model 接口，生产代码不需要兼容这些替身。"""

    def __init__(self, model, client):
        self.model = model
        self.client = client

    async def get_response(
        self,
        system_instructions,
        input,
        model_settings,
        tools,
        output_schema,
        handoffs,
        tracing,
        **kwargs,
    ):
        schemas = [
            {
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.params_json_schema,
                "strict": tool.strict_json_schema,
            }
            for tool in tools
        ]
        response = await asyncio.to_thread(
            self.client.responses.create,
            model=self.model,
            input=input,
            tools=schemas,
        )
        output = []
        for item in response.output:
            if item.type == "function_call":
                output.append(
                    ResponseFunctionToolCall(
                        type="function_call",
                        id=uuid4().hex,
                        call_id=item.call_id,
                        name=item.name,
                        arguments=item.arguments,
                        status="completed",
                    )
                )
            elif item.type == "message":
                data = to_json_value(item)
                content = data.get("content") or [
                    {
                        "type": "output_text",
                        "text": getattr(response, "output_text", data.get("text", "")),
                        "annotations": [],
                    }
                ]
                output.append(
                    ResponseOutputMessage(
                        type="message",
                        id=uuid4().hex,
                        role="assistant",
                        status="completed",
                        content=content,
                    )
                )
        if not output and getattr(response, "output_text", ""):
            output.append(
                ResponseOutputMessage(
                    type="message",
                    id=uuid4().hex,
                    role="assistant",
                    status="completed",
                    content=[
                        ResponseOutputText(
                            type="output_text", text=response.output_text, annotations=[]
                        )
                    ],
                )
            )
        return ModelResponse(output=output, usage=Usage(), response_id=uuid4().hex)

    async def stream_response(self, *args, **kwargs):
        raise AssertionError("流式验收使用本地 HTTP 模型，不使用这个数据替身")
        yield  # pragma: no cover


@pytest.fixture(autouse=True)
def sdk_fixture_models(monkeypatch):
    original = runtime.OpenAIResponsesModel

    def model_factory(*, model, openai_client):
        if isinstance(openai_client, (AsyncOpenAI, OpenAI)):
            return original(model=model, openai_client=openai_client)
        return FixtureModel(model, openai_client)

    monkeypatch.setattr(runtime, "OpenAIResponsesModel", model_factory)
    monkeypatch.setenv("BIT_AGENT_STREAMING", "0")
