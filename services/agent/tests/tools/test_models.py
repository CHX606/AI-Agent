import pytest
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus
from pydantic import ValidationError


def test_success_result_serializes_with_string_status() -> None:
    value = ToolResult(
        tool_call_id="call_1",
        tool_name="read_file",
        status=ToolStatus.SUCCESS,
        output="ok",
        metadata=ToolMetadata(duration_ms=2),
    )
    assert value.model_dump(mode="json")["status"] == "SUCCESS"


def test_failed_result_requires_error() -> None:
    with pytest.raises(ValidationError):
        ToolResult(
            tool_call_id="call_1",
            tool_name="read_file",
            status=ToolStatus.ERROR,
            metadata=ToolMetadata(duration_ms=0),
        )


def test_success_result_rejects_error() -> None:
    with pytest.raises(ValidationError):
        ToolResult(
            tool_call_id="call_1",
            tool_name="read_file",
            status=ToolStatus.SUCCESS,
            error=ToolError(
                code="INTERNAL_ERROR",
                message="成功结果不应携带错误",
                retryable=False,
            ),
            metadata=ToolMetadata(duration_ms=0),
        )


def test_error_model_is_structured() -> None:
    error = ToolError(code="FILE_NOT_FOUND", message="missing", retryable=True)
    assert error.code == "FILE_NOT_FOUND"
