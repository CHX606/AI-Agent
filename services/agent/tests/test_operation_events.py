import json

from bit_agent.agent.runtime import tool_operation


def test_tool_operation_exposes_readable_target_without_patch_body() -> None:
    patch = "*** Begin Patch\n*** Update File: src/app.py\n@@\n-secret\n+fixed\n*** End Patch\n"
    operation = tool_operation("apply_patch", json.dumps({"patch": patch}))

    assert operation == {"kind": "apply_patch", "label": "修改文件", "target": "src/app.py"}
    assert "secret" not in json.dumps(operation)


def test_tool_operation_describes_search_and_verification() -> None:
    search = tool_operation("search_code", json.dumps({"query": "ContextManager", "path": ""}))
    verify = tool_operation("verify_project", "{}")

    assert search["target"] == "“ContextManager”"
    assert verify["target"] == "当前项目"
