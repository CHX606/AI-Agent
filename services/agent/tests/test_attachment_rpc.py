"""First-turn attachment failures keep actionable messages across the actual RPC."""

import json
from io import BytesIO, StringIO
from zipfile import ZipFile

import pytest
from bit_agent.runtime.bootstrap import create_runtime
from bit_agent.runtime.transport.rpc import JsonLineRpcServer
from test_attachment_documents import attachment
from test_attachment_sdk import FILE
from test_image_inputs import IMAGE


def incomplete_office_archive():
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr("readme.txt", "Not an Office document")
    return stream.getvalue()


@pytest.mark.parametrize(
    "file,expected",
    [
        (attachment("broken.pdf", b"not a PDF"), "无法读取附件 broken.pdf"),
        (attachment("broken.docx", b"not a Word document"), "无法读取附件 broken.docx"),
        (attachment("broken.xlsx", b"not a workbook"), "无法读取附件 broken.xlsx"),
        (attachment("binary.exe", b"MZ\x00binary"), "附件不是可读文本"),
        (attachment("too-long.txt", b"a" * 200_001), "附件正文超过 200000 字符"),
        (
            attachment("incomplete.docx", incomplete_office_archive()),
            "无法读取附件 incomplete.docx",
        ),
        (
            attachment("incomplete.xlsx", incomplete_office_archive()),
            "无法读取附件 incomplete.xlsx",
        ),
    ],
)
async def test_invalid_first_attachment_returns_specific_rpc_400(tmp_path, file, expected):
    runtime, output = create_runtime(tmp_path / "state"), StringIO()
    await runtime.start()
    try:
        server = JsonLineRpcServer({"create_task": runtime.create_task}, output)
        await server.dispatch(
            json.dumps(
                {
                    "id": "initial-attachment",
                    "method": "create_task",
                    "params": {
                        "input": {
                            "objective": "",
                            "workspace_root": str(tmp_path),
                            "attachments": [file],
                        }
                    },
                }
            )
        )
        response = json.loads(output.getvalue())
        assert response["id"] == "initial-attachment"
        assert response["error"]["status_code"] == 400
        assert expected in response["error"]["user_message"]
        assert response["error"]["diagnostic_id"]
        assert file["data_url"] not in output.getvalue()
        assert (await runtime.list_sessions())["sessions"] == []
        assert runtime._running == {}
    finally:
        await runtime.close()


async def test_first_mixed_upload_count_error_is_visible_through_rpc(tmp_path):
    runtime, output = create_runtime(tmp_path / "state"), StringIO()
    await runtime.start()
    try:
        server = JsonLineRpcServer({"create_task": runtime.create_task}, output)
        await server.dispatch(
            json.dumps(
                {
                    "id": 1,
                    "method": "create_task",
                    "params": {
                        "input": {
                            "objective": "read",
                            "workspace_root": str(tmp_path),
                            "images": [IMAGE] * 5,
                            "attachments": [FILE],
                        }
                    },
                }
            )
        )
        error = json.loads(output.getvalue())["error"]
        assert error["status_code"] == 400
        assert error["user_message"] == "图片与附件每次合计最多 5 个"
        assert (await runtime.list_sessions())["sessions"] == []
    finally:
        await runtime.close()


async def test_other_submission_errors_keep_the_existing_rpc_visibility_policy(tmp_path):
    runtime, output = create_runtime(tmp_path / "state"), StringIO()
    await runtime.start()
    try:
        server = JsonLineRpcServer({"create_task": runtime.create_task}, output)
        await server.dispatch(
            json.dumps(
                {
                    "id": 1,
                    "method": "create_task",
                    "params": {
                        "input": {
                            "objective": "read",
                            "workspace_root": str(tmp_path / "missing"),
                            "attachments": [FILE],
                        }
                    },
                }
            )
        )
        error = json.loads(output.getvalue())["error"]
        assert error["status_code"] == 400
        assert "user_message" not in error
        assert "工作区不存在" not in error["message"]
    finally:
        await runtime.close()
