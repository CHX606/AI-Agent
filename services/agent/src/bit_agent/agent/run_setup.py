"""Validate the public run inputs and assemble one execution's dependencies."""

from pathlib import Path
from typing import Any
from uuid import uuid4

from openai import AsyncOpenAI, OpenAI

from bit_agent.agent.limits import validate_max_tool_rounds
from bit_agent.attachments import validate_attachments, validate_upload_limits
from bit_agent.context import (
    ContextManagementPolicy,
    ContextManager,
    FileContextArtifactStore,
    LLMContextSummarizer,
)
from bit_agent.images import validate_images
from bit_agent.memory import InMemoryWorkingMemoryStore
from bit_agent.observability import EventBus, JsonlEventSink, default_artifact_root
from bit_agent.tool_provider import LocalToolProvider

from .run_protocol import REASONING_EFFORTS


def _validate_options(options: dict[str, Any]) -> None:
    options["images"] = validate_images(options["images"])
    options["attachments"] = validate_attachments(options["attachments"])
    validate_upload_limits(options["images"], options["attachments"])
    prompt = options["prompt"]
    if not isinstance(prompt, str) or not (
        prompt.strip() or options["images"] or options["attachments"]
    ):
        raise ValueError("用户输入不能为空")
    options["max_tool_rounds"] = validate_max_tool_rounds(options["max_tool_rounds"])
    if options["working_memory_ttl_seconds"] <= 0:
        raise ValueError("working_memory_ttl_seconds 必须大于 0")
    objective = options["working_memory_objective"]
    if objective is not None and not objective.strip():
        raise ValueError("working_memory_objective 不能为空")
    if options["event_bus"] is not None and options["event_sink"] is not None:
        raise ValueError("event_bus 和 event_sink 不能同时传入")
    if not options["agent_id"].strip():
        raise ValueError("agent_id 不能为空")
    effort = options["reasoning_effort"]
    if effort is not None and effort not in REASONING_EFFORTS:
        raise ValueError("思考程度只能是 " + "、".join(REASONING_EFFORTS))


def _resolve_model(options: dict[str, Any]) -> None:
    if options["response_client"] is None or options["model_name"] is None:
        from bit_agent.llm.client import client, model_name

        options["response_client"] = options["response_client"] or client
        options["model_name"] = options["model_name"] or model_name
    if options["model_name"] is None:
        raise RuntimeError("缺少环境变量：MODEL_NAME")
    if options["model_api"] is None:
        options["model_api"] = "responses"
        if isinstance(options["response_client"], (OpenAI, AsyncOpenAI)):
            from bit_agent.llm.client import model_api

            options["model_api"] = model_api()
    if options["model_api"] not in {"responses", "chat_completions"}:
        raise ValueError("model_api 只能是 responses 或 chat_completions")


def _resolve_context(options: dict[str, Any]) -> ContextManager:
    manager, policy, directory = (
        options["context_manager"],
        options["context_policy"],
        options["context_artifact_directory"],
    )
    if manager is not None:
        if policy is not None or directory is not None:
            raise ValueError(
                "传入 context_manager 时不能同时传 context_policy 或 context_artifact_directory"
            )
        return manager
    from . import runtime

    policy = policy or ContextManagementPolicy.from_environment()
    return ContextManager(
        policy=policy,
        summarizer=LLMContextSummarizer(
            options["response_client"],
            runtime._summary_model(options["response_client"], options["model_name"]),
            max_source_tokens=policy.summarization_input_tokens,
        ),
        artifact_store=FileContextArtifactStore(
            directory or (default_artifact_root() / "context" / options["run_id"])
        ),
    )


def prepare_run(options: dict[str, Any]) -> dict[str, Any]:
    from . import runtime

    _validate_options(options)
    _resolve_model(options)
    root = (options.pop("workspace_root") or Path.cwd()).resolve()
    run_id = uuid4().hex
    options["root"], options["run_id"] = root, run_id
    options["event_bus"] = options["event_bus"] or EventBus(
        run_id,
        [
            options.pop("event_sink")
            or JsonlEventSink(default_artifact_root() / "events" / f"{run_id}.jsonl")
        ],
    )
    options["context_manager"] = _resolve_context(options)
    options["provider"] = options.pop("tool_provider") or LocalToolProvider(
        root, runtime.execute_tool
    )
    options["memory_store"] = options.pop("working_memory_store") or InMemoryWorkingMemoryStore()
    options["restore_thread"] = options["thread_id"] is not None
    options["thread_id"] = options["thread_id"] or uuid4().hex
    return options
