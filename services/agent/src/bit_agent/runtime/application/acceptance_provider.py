"""Independent tester tools, revisions and evidence validation."""

import json
import time

from bit_agent.agent.runtime import execute_tool, tool_error_result
from bit_agent.runtime.application.ports import AcceptanceWorkspacePort
from bit_agent.runtime.domain.acceptance import TESTER_SCHEMAS, AcceptanceReport
from bit_agent.tool_provider import LocalToolProvider
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


class AcceptanceToolProvider(LocalToolProvider):
    def __init__(self, workspace: AcceptanceWorkspacePort):
        super().__init__(workspace.root, execute_tool)
        self.workspace = workspace
        self.revision = 0
        self.evidence: list[dict] = []
        self.report: dict | None = None

    async def model_tools(self):
        return [
            tool
            for tool in await super().model_tools()
            if tool["name"] in {"read_file", "list_files", "search_code"}
        ] + TESTER_SCHEMAS

    def state(self) -> dict:
        return {
            "snapshot_id": self.workspace.snapshot_id,
            "test_revision": self.revision,
            "report": self.report,
            "evidence": self.evidence,
        }

    def _validate_report(self, report: AcceptanceReport) -> None:
        known = {item["evidence_id"]: item for item in self.evidence}
        latest = {
            (item["project"], item["target"], item["language"]): item for item in self.evidence
        }
        for check in report.checks:
            if check.status == "PASSED" and not check.evidence_ids:
                raise ValueError("通过项必须引用真实执行证据")
            for identifier in check.evidence_ids:
                item = known.get(identifier)
                if item is None:
                    raise ValueError("引用了不存在的执行证据")
                if check.status == "PASSED" and (
                    not item["passed"]
                    or item["revision"] != self.revision
                    or latest[(item["project"], item["target"], item["language"])] is not item
                ):
                    raise ValueError("通过项引用了失败或已过期的执行证据，请重新测试")
        if report.verdict == "PASSED":
            if report.unverified or any(item.status != "PASSED" for item in report.checks):
                raise ValueError("存在未验证或失败项，不能报告通过")
            if not latest or any(not item["passed"] for item in latest.values()):
                raise ValueError("未执行测试或仍有失败的测试，不能报告通过")
        if report.verdict == "FAILED" and not any(c.status == "FAILED" for c in report.checks):
            raise ValueError("失败报告必须说明失败的验收项")

    async def call_tool(self, tool_name: str, tool_call_id: str, raw_arguments: str) -> ToolResult:
        started = time.monotonic()
        if tool_name in {"read_file", "list_files", "search_code"}:
            return await super().call_tool(tool_name, tool_call_id, raw_arguments)
        try:
            arguments = json.loads(raw_arguments)
            if not isinstance(arguments, dict):
                raise ValueError("参数必须是对象")
            operations = {
                "write_acceptance_test": self._write_test,
                "run_acceptance_test": self._run_test,
                "submit_acceptance_report": self._submit_report,
            }
            operation = operations.get(tool_name)
            if operation is None:
                return tool_error_result(
                    tool_call_id, tool_name, "PERMISSION_DENIED", "测试 Agent 不允许使用该工具"
                )
            output = await operation(arguments, tool_call_id)
            await self.workspace.save_report(self.state())
            return self._tool_result(tool_name, tool_call_id, output, started)
        except (ValueError, OSError, TypeError, RuntimeError) as exc:
            self.report = None
            return tool_error_result(tool_call_id, tool_name, "ACCEPTANCE_TOOL_ERROR", str(exc))

    async def _write_test(self, arguments: dict, _call_id: str) -> dict:
        self._validate_arguments(
            arguments,
            {"project", "filename", "content"},
            "需要 project、filename、content 字符串参数",
        )
        target = await self.workspace.write_test(**arguments)
        self.revision += 1
        self.report = None
        return {
            "target": target,
            "revision": self.revision,
            "note": "只写入隔离副本；此前执行证据已失效，请重新运行测试",
        }

    async def _run_test(self, arguments: dict, call_id: str) -> dict:
        self._validate_arguments(
            arguments,
            {"project", "target", "language"},
            "需要 project、target、language 字符串参数",
        )
        self.report = None
        try:
            output = await self.workspace.run_test(**arguments, call_id=call_id)
        except (ValueError, OSError, RuntimeError) as exc:
            output = {
                **arguments,
                "passed": False,
                "start_error": str(exc),
                "exit_code": None,
                "command": [],
                "stdout": "",
                "stderr": "",
            }
        output.update(evidence_id=call_id, revision=self.revision)
        self.evidence.append(output)
        return output

    async def _submit_report(self, arguments: dict, _call_id: str) -> dict:
        report = AcceptanceReport.model_validate(arguments)
        self._validate_report(report)
        self.report = report.model_dump()
        return self.report

    def _validate_arguments(self, arguments: dict, keys: set[str], message: str) -> None:
        if set(arguments) != keys or not all(
            isinstance(value, str) for value in arguments.values()
        ):
            raise ValueError(message)

    def _tool_result(
        self, tool_name: str, call_id: str, output: dict, started: float
    ) -> ToolResult:
        failed = tool_name == "run_acceptance_test" and not output["passed"]
        return ToolResult(
            tool_call_id=call_id,
            tool_name=tool_name,
            status=ToolStatus.ERROR if failed else ToolStatus.SUCCESS,
            output=output,
            error=ToolError(
                code="ACCEPTANCE_TEST_FAILED", message="查看实际命令结果", retryable=False
            )
            if failed
            else None,
            metadata=ToolMetadata(
                duration_ms=int((time.monotonic() - started) * 1000),
                truncated=bool(output.get("truncated", False)),
            ),
        )
