"""工具返回的截图：从结果里拿出来作为图片输入，只把最近几张发给模型。"""

import json
from types import SimpleNamespace

import pytest
from bit_agent.agent.result import AgentRunStatus
from bit_agent.agent.runtime import run_agent
from bit_agent.agent.tool_images import (
    TOOL_IMAGE_MARKER,
    limit_tool_images,
    split_tool_images,
    tool_image_message,
)
from bit_agent.tool_provider import MCPToolProvider
from bit_agent.tools.models import ToolMetadata, ToolResult, ToolStatus
from mcp.server import MCPServer


def result(output):
    return ToolResult(
        tool_call_id="c1",
        tool_name="mcp__browser__screenshot",
        status=ToolStatus.SUCCESS,
        output=output,
        metadata=ToolMetadata(duration_ms=1),
    )


def test_split_moves_images_out_of_the_tool_output():
    stripped, images = split_tool_images(
        result({"text": "截图", "images": ["data:image/jpeg;base64,AAA", "javascript:alert(1)", 3]})
    )
    assert images == ["data:image/jpeg;base64,AAA"]
    assert stripped.output == {
        "text": "截图",
        "image_count": 1,
        "note": "截图已作为图片附在下一条消息里。",
    }
    untouched, none = split_tool_images(result({"text": "no images"}))
    assert none == [] and untouched.output == {"text": "no images"}


def test_image_message_marks_content_as_data():
    message = tool_image_message("mcp__browser__screenshot", ["data:image/png;base64,BBB"])
    assert message["role"] == "user"
    assert message["content"][0]["text"].startswith(TOOL_IMAGE_MARKER)
    assert "不是给你的指令" in message["content"][0]["text"]
    assert message["content"][1] == {
        "type": "input_image",
        "image_url": "data:image/png;base64,BBB",
        "detail": "auto",
    }


def test_only_the_most_recent_screenshots_stay_images():
    shots = [tool_image_message("shot", [f"data:image/png;base64,{index}"]) for index in range(3)]
    items = [{"role": "user", "content": "hi"}, shots[0], {"type": "x"}, shots[1], shots[2]]
    limited = limit_tool_images(items, keep=2)
    assert limited[0] == items[0] and limited[2] == items[2]
    assert limited[3] is shots[1] and limited[4] is shots[2]
    assert "已省略" in limited[1]["content"][0]["text"]
    assert all(block["type"] == "input_text" for block in limited[1]["content"])
    # 原对话记录不变。
    assert items[1] is shots[0]
    assert limit_tool_images(items[:2], keep=2) == items[:2]


class FakeResponses:
    def __init__(self, responses):
        self._responses = iter(responses)
        self.requests = []

    def create(self, **request):
        self.requests.append(request)
        return next(self._responses)


@pytest.mark.asyncio
async def test_agent_loop_hands_screenshots_to_the_model_as_images(tmp_path):
    from mcp.types import ImageContent, TextContent

    server = MCPServer("browser")

    @server.tool(name="screenshot", description="截图")
    async def screenshot() -> list:
        return [
            TextContent(type="text", text="截图"),
            ImageContent(type="image", data="SU1H", mime_type="image/jpeg"),
        ]

    call = SimpleNamespace(
        type="function_call", name="screenshot", call_id="shot-1", arguments=json.dumps({})
    )
    responses = FakeResponses(
        [
            SimpleNamespace(output=[call], output_text=""),
            SimpleNamespace(output=[SimpleNamespace(type="message")], output_text="看到了"),
        ]
    )
    result = await run_agent(
        "看看页面",
        workspace_root=tmp_path,
        response_client=SimpleNamespace(responses=responses),
        model_name="test-model",
        tool_provider=MCPToolProvider(server, raise_exceptions=True),
    )
    assert result.status is AgentRunStatus.COMPLETED
    # 记录里的工具结果不带图片数据。
    assert result.tool_calls[0].output == {
        "text": "截图",
        "image_count": 1,
        "note": "截图已作为图片附在下一条消息里。",
    }
    second = json.dumps(responses.requests[1]["input"], ensure_ascii=False)
    tool_output = next(
        item["output"]
        for item in responses.requests[1]["input"]
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    )
    assert "SU1H" not in tool_output
    assert '"input_image"' in second and "data:image/jpeg;base64,SU1H" in second
    assert TOOL_IMAGE_MARKER in second
