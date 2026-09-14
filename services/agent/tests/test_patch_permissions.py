"""用临时工作区和实际 Git 验证补丁权限，不连接模型。"""

import json
from pathlib import Path

import pytest
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application.delegation import DelegatingToolProvider
from bit_agent.runtime.infrastructure.changes import ChangeJournal
from bit_agent.runtime.infrastructure.verification import verify_project
from bit_agent.tools.models import ToolStatus

DELETE_HUNK = "--- a/demo.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-important content\n"
DELETE_PATCHES = [
    pytest.param(
        "diff --git a/demo.txt b/demo.txt\n" + DELETE_HUNK,
        b"important content\n",
        id="git-without-mode-header",
    ),
    pytest.param(DELETE_HUNK, b"important content\n", id="plain-unified"),
    pytest.param(
        "diff --git a/demo.txt b/demo.txt\ndeleted file mode 100644\n" + DELETE_HUNK,
        b"important content\n",
        id="git-mode-header",
    ),
    pytest.param(
        "diff --git a/demo.txt b/demo.txt\ndeleted file mode 100644\n",
        b"",
        id="empty-file-mode-only",
    ),
    pytest.param(
        "*** Begin Patch\n*** Delete File: demo.txt\n*** End Patch\n",
        b"important content\n",
        id="begin-patch",
    ),
]


class RecordingInteraction:
    def __init__(self, option_id: str) -> None:
        self.option_id = option_id
        self.requests: list[dict] = []

    async def ask(self, question, *, operation):
        self.requests.append({"question": question, "operation": operation})
        return {"source": "user", "option_id": self.option_id}


def provider_for(root: Path, permission: str, interaction) -> DelegatingToolProvider:
    return DelegatingToolProvider(
        root,
        "off",
        InMemoryEventSink(),
        root / "artifacts",
        interaction,
        permission_mode=permission,
        journal=ChangeJournal(root, root / "artifacts"),
        verifier=verify_project,
    )


@pytest.mark.parametrize(("patch", "content"), DELETE_PATCHES)
@pytest.mark.parametrize("decision", ["reject", "approve"])
async def test_edit_deletion_requires_explicit_approval(tmp_path, patch, content, decision):
    target = tmp_path / "demo.txt"
    target.write_bytes(content)
    interaction = RecordingInteraction(decision)
    provider = provider_for(tmp_path, "edit", interaction)

    result = await provider.call_tool("apply_patch", "call", json.dumps({"patch": patch}))

    assert len(interaction.requests) == 1
    request = interaction.requests[0]
    assert request["question"].requires_confirmation
    assert "demo.txt" in request["operation"]["detail"]
    if decision == "approve":
        assert result.status is ToolStatus.SUCCESS, result
        assert not target.exists()
        assert provider.journal.entries[0]["status"] == "unreviewed"
    else:
        assert result.error.code == "PERMISSION_DENIED"
        assert target.read_bytes() == content
        assert provider.journal.entries == []
        assert not provider.changed_paths


@pytest.mark.parametrize("action", ["Add", "Update"])
async def test_edit_ordinary_patch_does_not_ask_about_deletion_text(tmp_path, action):
    target = tmp_path / "demo.txt"
    if action == "Update":
        target.write_bytes(b"old\n")
    body = "@@\n-old\n" if action == "Update" else ""
    patch = (
        f"*** Begin Patch\n*** {action} File: demo.txt\n"
        + body
        + "+deleted file mode 100644\n++++ /dev/null\n*** End Patch\n"
    )
    interaction = RecordingInteraction("reject")
    provider = provider_for(tmp_path, "edit", interaction)

    result = await provider.call_tool("apply_patch", "call", json.dumps({"patch": patch}))

    assert result.status is ToolStatus.SUCCESS, result
    assert target.read_text(encoding="utf-8") == "deleted file mode 100644\n+++ /dev/null\n"
    assert interaction.requests == []


async def test_confirm_still_requires_approval_for_ordinary_patch(tmp_path):
    interaction = RecordingInteraction("reject")
    provider = provider_for(tmp_path, "confirm", interaction)
    patch = "*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch\n"

    result = await provider.call_tool("apply_patch", "call", json.dumps({"patch": patch}))

    assert result.error.code == "PERMISSION_DENIED"
    assert len(interaction.requests) == 1
    assert not (tmp_path / "demo.txt").exists()


async def test_read_only_rejects_deletion_without_asking(tmp_path):
    target = tmp_path / "demo.txt"
    target.write_bytes(b"important content\n")
    interaction = RecordingInteraction("approve")
    provider = provider_for(tmp_path, "read_only", interaction)

    result = await provider.call_tool("apply_patch", "call", json.dumps({"patch": DELETE_HUNK}))

    assert result.error.code == "PERMISSION_DENIED"
    assert target.read_bytes() == b"important content\n"
    assert interaction.requests == []
