"""在工作区直接执行检查；只有失败时才按需运行安全基线副本。"""

from pathlib import Path

from bit_agent.sandbox import OSSandbox, sandbox_status
from bit_agent.security.paths import PathSecurityError, resolve_workspace_path
from bit_agent.tools.command_runtime import command_dependency_error

from .baseline import write_baseline
from .comparison import _kind, _passed, compare_with_baseline


async def _run(directory: Path, project: dict, command: list[str], call_id: str) -> dict:
    sandbox = OSSandbox(task_id="verification", tool_call_id=call_id)
    outcome = await sandbox.run(directory, command, project["timeout"])
    return {
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "start_error": outcome.start_error,
        "timed_out": outcome.timed_out,
        "truncated": outcome.truncated,
    }


class VerificationExecution:
    def __init__(
        self,
        root: Path,
        call_id: str,
        originals: dict[str, str | None] | None,
        comparable: bool,
        temporary: Path,
    ) -> None:
        self.root, self.call_id, self.originals = root, call_id, originals
        self.comparable, self.temporary = comparable, temporary
        self.baseline_root: Path | None = None
        self.baseline_error = ""
        self.unavailable = ""
        self.failed = False
        self.checks: list[dict] = []
        self.notes: list[str] = []
        self.unverified: list[dict] = []

    async def run_projects(self, projects: list[dict]) -> None:
        for project in projects:
            if self.unavailable:
                self.unverified.append({"paths": project["paths"], "reason": self.unavailable})
                continue
            await self._project(project)
            if self.failed:
                break

    async def _project(self, project: dict) -> None:
        directory = resolve_workspace_path(self.root, project["root"], allow_root=True)
        for command in project["commands"]:
            current = await _run(directory, project, command, self.call_id)
            record = {
                "project": project["root"],
                "language": project["language"],
                "command": command,
                **current,
                "status": "PASSED",
            }
            self.checks.append(record)
            if _passed(current):
                continue
            status, detail = await self._status(project, command, current, record)
            record["status"], record["detail"] = status, detail
            self._record(project, status, detail, command)
            if self.failed or self.unavailable:
                break

    def _record(self, project: dict, status: str, detail: str, command: list[str]) -> None:
        if status == "FAILED":
            self.failed = True
        elif status == "UNVERIFIED":
            self.unverified.append({"paths": project["paths"], "reason": detail})
        else:
            self.notes.append(f"{' '.join(command)}：{detail}")

    async def _status(
        self, project: dict, command: list[str], current: dict, record: dict
    ) -> tuple[str, str]:
        if current["start_error"]:
            availability = await sandbox_status()
            reason = f"无法启动检查命令：{current['start_error']}"
            if not availability["available"]:
                self.unavailable = str(availability["message"]) or reason
                reason = self.unavailable
            return "UNVERIFIED", reason
        missing = command_dependency_error(command, current["stdout"], current["stderr"])
        if missing:
            return "UNVERIFIED", missing
        if self.comparable:
            return await self._compare(project, command, current, record)
        if _kind(command) == "pytest" and current["exit_code"] == 5:
            return "UNVERIFIED", "项目没有可以运行的测试"
        return "FAILED", "检查未通过"

    async def _compare(
        self, project: dict, command: list[str], current: dict, record: dict
    ) -> tuple[str, str]:
        if self.baseline_error:
            return "UNVERIFIED", self.baseline_error
        if self.baseline_root is None:
            destination = self.temporary / "workspace"
            try:
                await write_baseline(self.root, self.originals or {}, destination)
            except (OSError, ValueError, PathSecurityError) as exc:
                self.baseline_error = f"无法建立安全的修改前副本：{exc}"
                return "UNVERIFIED", self.baseline_error
            self.baseline_root = destination
        before = await _run(
            resolve_workspace_path(self.baseline_root, project["root"], allow_root=True),
            project,
            command,
            self.call_id + "-baseline",
        )
        record["baseline"] = {
            "exit_code": before["exit_code"],
            "start_error": before["start_error"],
            "timed_out": before["timed_out"],
        }
        return compare_with_baseline(command, current, before)
