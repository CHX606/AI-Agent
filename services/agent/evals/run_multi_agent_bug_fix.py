"""使用真实模型运行一次 Multi-Agent Calculator Bug-Fix 端到端评测。"""

import asyncio
from pathlib import Path
from typing import Any

from bit_agent.agent import AgentRunResult, AgentRunStatus
from bit_agent.evals import EvalCase, EvalRunner
from bit_agent.multi_agent import MultiAgentRunResult, run_multi_agent


async def main() -> None:
    service_root = Path(__file__).resolve().parents[1]
    repository_root = service_root.parents[1]
    multi_agent_results: list[MultiAgentRunResult] = []

    async def multi_agent_runner(
        prompt: str,
        *,
        workspace_root: Path,
        **options: Any,
    ) -> AgentRunResult:
        result = await run_multi_agent(
            prompt,
            workspace_root=workspace_root,
            response_client=options.get("response_client"),
            model_name=options.get("model_name"),
        )
        multi_agent_results.append(result)
        if result.final_agent_result is not None:
            return result.final_agent_result
        return AgentRunResult(
            status=AgentRunStatus.FAILED,
            rounds=0,
            error=result.error or "Multi-Agent 没有产生主 Agent 结果",
        )

    case = EvalCase(
        name="multi-agent-bug-fix-calculator",
        prompt=(
            "这个项目存在一个功能错误，并且有测试无法通过。"
            "请自行定位问题、修复代码并运行测试验证，不要猜测文件内容。"
        ),
        fixture_path=service_root / "evals" / "fixtures" / "bug_fix_calculator",
        test_target="tests",
        allowed_paths=["calculator.py"],
        immutable_paths=["tests/**", "README.md", ".git/**", ".env", ".env.*"],
    )
    runner = EvalRunner(
        repository_root / "artifacts" / "evals",
        agent_runner=multi_agent_runner,
        temporary_root=repository_root / ".test-runs" / "multi-agent-eval",
    )
    evaluation = await runner.run(case)
    if multi_agent_results:
        (evaluation.artifact_directory / "multi_agent_result.json").write_text(
            multi_agent_results[0].model_dump_json(indent=2) + "\n",
            encoding="utf-8",
        )
    print("最终 Multi-Agent 评测结果：")
    print(evaluation.model_dump_json(indent=2))
    if not evaluation.passed:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
