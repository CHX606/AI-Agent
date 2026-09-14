"""Bit Agent 命令行入口。"""

import argparse
import json
import os
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from bit_agent.client import GatewayClient, GatewayClientError, GatewayEvent

DEFAULT_GATEWAY_URL = "http://127.0.0.1:3000"
TERMINAL_FAILURES = {"FAILED", "CANCELLED"}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _gateway_url(argument: str | None) -> str:
    return argument or os.getenv("BIT_AGENT_GATEWAY_URL") or DEFAULT_GATEWAY_URL


def _add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--gateway",
        help=f"Gateway 地址，默认读取 BIT_AGENT_GATEWAY_URL 或使用 {DEFAULT_GATEWAY_URL}",
    )
    parser.add_argument("--json", action="store_true", help="仅输出机器可读 JSON")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bit-agent", description="Bit Agent CLI")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="创建任务并等待执行结果")
    run.add_argument("--workspace", type=Path, required=True, help="要处理的项目目录")
    run.add_argument("--task", required=True, help="使用自然语言描述任务")
    run.add_argument("--detach", action="store_true", help="提交后立即返回任务信息")
    _add_common_options(run)

    for name, help_text in (
        ("status", "查询任务状态"),
        ("result", "获取任务最终结果"),
        ("cancel", "请求取消任务"),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("task_id")
        _add_common_options(command)
    return parser


def _print_event(event: GatewayEvent) -> None:
    payload = event.data if isinstance(event.data, dict) else {"value": event.data}
    agent = payload.get("agent_id") or payload.get("agent")
    suffix = f" [{agent}]" if agent else ""
    print(f"{event.id or '-'}  {event.event_type}{suffix}")


def _exit_code(payload: dict[str, Any]) -> int:
    return 1 if payload.get("status") in TERMINAL_FAILURES else 0


def _run(args: argparse.Namespace, client: GatewayClient) -> int:
    workspace = args.workspace.expanduser().resolve()
    if not workspace.is_dir():
        raise ValueError(f"工作区不存在：{workspace}")
    task = client.create_task(args.task.strip(), str(workspace))
    if args.detach:
        print(_json(task) if args.json else f"任务已提交：{task.get('task_id')}")
        return 0

    task_id = task.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise GatewayClientError("Gateway 创建任务后没有返回 task_id")
    if not args.json:
        print(f"任务已提交：{task_id}")
        for event in client.iter_events(task_id):
            _print_event(event)
    else:
        for _ in client.iter_events(task_id):
            pass
    result = client.get_result(task_id)
    print(_json(result))
    return _exit_code(result)


def _dispatch(args: argparse.Namespace, client: GatewayClient) -> int:
    if args.command == "run":
        return _run(args, client)
    if args.command == "status":
        payload = client.get_task(args.task_id)
    elif args.command == "result":
        payload = client.get_result(args.task_id)
    else:
        payload = client.cancel_task(args.task_id)

    if args.json or args.command == "result":
        print(_json(payload))
    else:
        print(f"{payload.get('task_id', args.task_id)}  {payload.get('status', 'UNKNOWN')}")
    return _exit_code(payload)


def main(
    argv: Sequence[str] | None = None,
    *,
    client_factory: Callable[[str], GatewayClient] = GatewayClient,
) -> int:
    args = build_parser().parse_args(argv)
    try:
        client = client_factory(_gateway_url(args.gateway))
        return _dispatch(args, client)
    except (GatewayClientError, OSError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
