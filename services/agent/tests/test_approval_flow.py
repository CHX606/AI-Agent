"""权限确认和运行中输入：拒绝检查不循环、拒绝可带意见、批准不占提问名额、对话内批准、边跑边补充。"""

import asyncio
import json
from types import SimpleNamespace

from bit_agent.agent.runtime import run_agent
from bit_agent.agent.verification import USER_DECLINED_NOTE, VerificationState
from bit_agent.observability import InMemoryEventSink
from bit_agent.runtime.application.interaction import QuestionOption, UserQuestion
from bit_agent.tools.models import ToolMetadata, ToolResult, ToolStatus
from test_verification_baseline import PATCH, answer, call, control, provider, until


def denied(name: str):
    record = call(name, None, False)
    return record.model_copy(
        update={"error": record.error.model_copy(update={"code": "PERMISSION_DENIED"})}
    )


def test_declined_check_lets_the_task_finish_as_unverified():
    state = VerificationState(require_independent_acceptance=True)
    state.observe("apply_patch", call("apply_patch", {}, True, ["a.py"]))
    state.observe("verify_project", denied("verify_project"))
    assert not state.has_unverified_changes, "用户拒绝检查后不能再催模型验证"
    assert state.status == "UNVERIFIED"
    assert USER_DECLINED_NOTE in state.notes


def test_inconclusive_acceptance_lets_the_task_finish_honestly():
    """真实遇到的循环：基础检查通过 → 验收执行器没跑起来（NOT_VERIFIED）
    → 被要求重验，每次 3 分钟。"""
    state = VerificationState(require_independent_acceptance=True)
    state.observe("apply_patch", call("apply_patch", {}, True, ["todo.py"]))
    state.observe("verify_project", call("verify_project", {"outcome": "PASSED"}, True))
    assert state.has_unverified_changes, "基础检查通过后仍需独立验收"
    inconclusive = {"verdict": "NOT_VERIFIED", "summary": "执行器没有启动测试。其余说明"}
    state.observe("verify_task", call("verify_task", inconclusive, False))
    assert not state.has_unverified_changes
    assert state.acceptance_status == "NOT_VERIFIED"
    assert "独立验收没能完成：执行器没有启动测试" in state.notes
    # 发现缺陷（FAILED）时仍然必须修复，不能直接收尾。
    state.observe("verify_project", call("verify_project", {"outcome": "PASSED"}, True))
    state.observe("verify_task", call("verify_task", {"verdict": "FAILED"}, False))
    assert state.has_unverified_changes


def test_refused_checks_do_not_reset_the_reminder_counter():
    state = VerificationState()
    state.observe("apply_patch", call("apply_patch", {}, True, ["a.py"]))
    for _ in range(3):
        assert not state.reminded()
        refused = call("verify_task", None, False)
        refused = refused.model_copy(
            update={"error": refused.error.model_copy(update={"code": "ACCEPTANCE_NOT_VERIFIED"})}
        )
        state.observe("verify_task", refused)
    assert state.reminded(), "没有真正运行的检查不算做过验证"


async def test_agent_stops_asking_after_the_user_declines_the_check(tmp_path):
    """复现过的循环：拒绝基础检查 → 被要求验证 → 再申请 → 再拒绝……共 98 次。"""

    class Provider:
        def __init__(self):
            self.calls: list[str] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def model_tools(self):
            return [
                {
                    "type": "function",
                    "name": name,
                    "description": name,
                    "parameters": {"type": "object", "properties": {}},
                }
                for name in ("apply_patch", "verify_project")
            ]

        async def call_tool(self, name, identifier, arguments):
            self.calls.append(name)
            ok = name == "apply_patch"
            return ToolResult(
                tool_call_id=identifier,
                tool_name=name,
                status=ToolStatus.SUCCESS if ok else ToolStatus.ERROR,
                output={} if ok else None,
                error=None
                if ok
                else {"code": "PERMISSION_DENIED", "message": "x", "retryable": False},
                metadata=ToolMetadata(duration_ms=0, affected_paths=["a.py"] if ok else []),
            )

    class Model:
        """改完先想结束；被提醒时去申请检查（守规矩的模型都会这样做）。"""

        def __init__(self):
            self.responses = self
            self.index = 0

        def create(self, **request):
            self.index += 1
            last = json.dumps(request["input"][-1], ensure_ascii=False, default=str)
            if self.index == 1 or "verify_project" in last and "PERMISSION_DENIED" not in last:
                name = "apply_patch" if self.index == 1 else "verify_project"
                item = SimpleNamespace(
                    type="function_call", call_id=str(self.index), name=name, arguments="{}"
                )
                return SimpleNamespace(output=[item], output_text="")
            return SimpleNamespace(output=[], output_text="已修改，按你的选择没有运行检查")

    tools = Provider()
    result = await run_agent(
        "改一下 a.py",
        workspace_root=tmp_path,
        response_client=Model(),
        model_name="fixture",
        tool_provider=tools,
        event_sink=InMemoryEventSink(),
        require_independent_acceptance=True,
    )
    assert result.status == "COMPLETED", result.error
    assert result.verification_status == "UNVERIFIED"
    assert tools.calls.count("verify_project") == 1


async def test_written_reply_to_an_approval_is_a_rejection_with_feedback(tmp_path):
    interaction = await control(tmp_path)
    tools = provider(tmp_path, interaction)
    pending = asyncio.create_task(
        tools.call_tool("apply_patch", "c1", json.dumps({"patch": PATCH.format(name="a.py")}))
    )
    await until(lambda: interaction.question is not None)
    question = interaction.question
    assert [item["id"] for item in question["options"]] == ["approve", "approve_task", "reject"]
    await interaction.request(
        {"action": "answer", "question_id": question["id"], "text": "文件名改成 b.py"}
    )
    result = await pending
    assert result.error.code == "PERMISSION_DENIED"
    assert "文件名改成 b.py" in result.error.message
    assert not (tmp_path / "a.py").exists()
    interaction.storage.close()


async def test_approvals_do_not_use_up_the_question_limit(tmp_path):
    interaction = await control(tmp_path)
    tools = provider(tmp_path, interaction)
    for index in range(22):
        pending = asyncio.create_task(
            tools.call_tool(
                "apply_patch", f"c{index}", json.dumps({"patch": PATCH.format(name=f"f{index}.py")})
            )
        )
        await answer(interaction, "approve")
        assert (await pending).status is ToolStatus.SUCCESS
    # Agent 自己提的问题仍然有上限。
    interaction.question_count = 20
    question = UserQuestion(
        question="选哪个？",
        options=[
            QuestionOption(id="a", label="A", description="a"),
            QuestionOption(id="b", label="B", description="b"),
        ],
        recommended_option_id="a",
        requires_confirmation=False,
    )
    try:
        await interaction.ask(question)
    except ValueError as exc:
        assert "上限" in str(exc)
    else:
        raise AssertionError("Agent 的提问应该受上限约束")
    interaction.storage.close()


async def test_isolated_checks_run_without_asking_in_confirm_mode(tmp_path):
    interaction = await control(tmp_path)
    tools = provider(tmp_path, interaction)

    async def verifier(root, changed, call_id, originals=None):
        return ToolResult(
            tool_call_id=call_id,
            tool_name="verify_project",
            status=ToolStatus.SUCCESS,
            output={"outcome": "NOT_APPLICABLE"},
            metadata=ToolMetadata(duration_ms=0),
        )

    tools.verifier = verifier
    result = await asyncio.wait_for(tools.call_tool("verify_project", "c1", "{}"), 2)
    assert result.output["outcome"] == "NOT_APPLICABLE"
    assert interaction.question is None and interaction.question_count == 0
    interaction.storage.close()


async def test_approve_for_conversation_carries_over_to_the_next_turn(tmp_path):
    interaction = await control(tmp_path)
    shared: set[str] = set()
    first = provider(tmp_path, interaction)
    first.approved_categories = shared
    pending = asyncio.create_task(
        first.call_tool("apply_patch", "c1", json.dumps({"patch": PATCH.format(name="a.py")}))
    )
    await answer(interaction, "approve_task")
    assert (await pending).status is ToolStatus.SUCCESS
    # 下一轮（新任务）使用同一对话的批准集合，不再询问。
    second = provider(tmp_path, interaction)
    second.approved_categories = shared
    result = await asyncio.wait_for(
        second.call_tool("apply_patch", "c2", json.dumps({"patch": PATCH.format(name="b.py")})), 2
    )
    assert result.status is ToolStatus.SUCCESS
    interaction.storage.close()


async def test_requirements_can_be_added_while_running(tmp_path):
    interaction = await control(tmp_path)
    task = await interaction.request({"action": "supplement", "text": "顺便加上注释"})
    assert task["status"] == "RUNNING"
    updates = await interaction.boundary()
    assert [update["text"] for update in updates] == ["顺便加上注释"]
    interaction.storage.close()
