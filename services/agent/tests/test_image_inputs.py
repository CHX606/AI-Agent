"""Upload validation happens before persistence or SDK requests."""

import base64
import io
import json

import pytest
from bit_agent.images import image_metadata, user_message, validate_images
from bit_agent.images.validation import MAX_IMAGE_BYTES, MAX_INPUT_BYTES
from bit_agent.runtime.transport.rpc import JsonLineRpcServer

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII="
IMAGE = {
    "name": "capture.png",
    "mime_type": "image/png",
    "data_url": f"data:image/png;base64,{PNG}",
}


def image(data, mime="image/png", name="capture.png"):
    return {
        "name": name,
        "mime_type": mime,
        "data_url": f"data:{mime};base64," + base64.b64encode(data).decode(),
    }


@pytest.mark.parametrize(
    "value",
    [
        {},
        "image.png",
        [IMAGE] * 6,
        [{**IMAGE, "extra": 1}],
        [{**IMAGE, "name": "../capture.png"}],
        [{**IMAGE, "name": "C:\\capture.png"}],
        [{**IMAGE, "name": ".."}],
        [{**IMAGE, "name": "x" * 256}],
        [{**IMAGE, "name": "x\x00.png"}],
        [{**IMAGE, "name": "x\x85.png"}],
        [{**IMAGE, "mime_type": []}],
        [{**IMAGE, "mime_type": "image/svg+xml"}],
        [{**IMAGE, "data_url": "https://example.invalid/image.png"}],
        [{**IMAGE, "data_url": "data:image/jpeg;base64," + PNG}],
        [{**IMAGE, "data_url": IMAGE["data_url"] + "\n"}],
        [{**IMAGE, "data_url": "data:image/png;base64,"}],
        [{**IMAGE, "data_url": "data:image/png;base64,iVBORw0KGgq="}],
        [image(b"not an image")],
    ],
)
def test_invalid_image_batches_are_rejected(value):
    with pytest.raises(ValueError):
        validate_images(value)


@pytest.mark.parametrize(
    "data,mime",
    [
        (base64.b64decode(PNG), "image/png"),
        (b"\xff\xd8\xff\xe0payload", "image/jpeg"),
        (b"RIFF\x00\x00\x00\x00WEBPpayload", "image/webp"),
        (base64.b64decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="), "image/gif"),
    ],
)
def test_matching_signatures_are_accepted(data, mime):
    value = image(data, mime)
    assert validate_images([value]) == [value]
    assert image_metadata([value])[0]["size"] == len(data)


def test_gif_animation_is_rejected_and_comment_comma_is_not_an_image_frame():
    static = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
    frame = static[static.index(b",") : -1]
    animated = static[:-1] + frame + b";"
    with pytest.raises(ValueError, match="动画"):
        validate_images([image(animated, "image/gif")])
    comment = b"!\xfe\x01,\x00"
    assert validate_images([image(static[:-1] + comment + b";", "image/gif")])


def test_single_and_batch_decoded_size_limits():
    valid = image(b"\x89PNG\r\n\x1a\n" + b"x" * (MAX_IMAGE_BYTES - 8))
    assert validate_images([valid] * 4)
    with pytest.raises(ValueError, match="合计"):
        validate_images([valid] * 5)
    with pytest.raises(ValueError, match="单张|过大"):
        validate_images([image(b"\x89PNG\r\n\x1a\n" + b"x" * MAX_IMAGE_BYTES)])


def test_image_only_message_uses_visual_content_without_placeholder_text():
    assert user_message("", [IMAGE]) == {
        "role": "user",
        "content": [{"type": "input_image", "image_url": IMAGE["data_url"], "detail": "auto"}],
    }
    assert user_message("hello") == {"role": "user", "content": "hello"}


async def test_rpc_utf8_limit_and_oversized_line_draining(monkeypatch):
    import bit_agent.runtime.transport.rpc as rpc

    assert MAX_INPUT_BYTES == 28 * 1024 * 1024
    monkeypatch.setattr(rpc, "MAX_INPUT_BYTES", 120)
    calls = []

    async def method(**params):
        calls.append(params)
        return True

    output = io.StringIO()
    server = JsonLineRpcServer({"method": method}, output)
    request = (
        json.dumps({"id": 1, "method": "method", "params": {"text": "中" * 35}}, ensure_ascii=False)
        + "\n"
    )
    assert len(request) < 120 < len(request.encode())
    await server.dispatch(request)
    source = io.StringIO(" " * 200 + "\n" + '{"id":2,"method":"method","params":{}}\n')
    await server.serve(source)
    responses = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [item["error"]["status_code"] for item in responses[:2]] == [413, 413]
    assert responses[-1] == {"id": 2, "result": True}
    assert calls == [{}]
