from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from bit_agent.images import readable_objective
from bit_agent.observability.diagnostics import (
    failure,
)
from bit_agent.runtime.application.delegation import (
    auxiliary_model,
)
from bit_agent.runtime.application.interaction import (
    InteractionError,
)

from .service_protocol import (
    BRANCH_NAME,
    COMMIT_MESSAGE_INSTRUCTIONS,
    TERMINAL,
)


class ChangeCommands:
    async def get_changes(self, task_id: str) -> dict[str, Any]:
        task = await self.get_task(task_id)
        if task is None:
            raise InteractionError("任务不存在", 404)
        return self.journal_factory(
            Path(task["workspace_root"]), self.storage.directory / "artifacts" / task_id
        ).public()

    async def review_change(self, task_id: str, change_id: str, action: str) -> dict[str, Any]:
        task = await self.get_task(task_id)
        if task is None:
            raise InteractionError("任务不存在", 404)
        if task["status"] not in TERMINAL:
            raise InteractionError("请先结束任务，再保留或撤销改动")
        root = Path(task["workspace_root"])
        async with self._workspaces.hold(root, wait=False):
            journal = self.journal_factory(root, self.storage.directory / "artifacts" / task_id)
            result = journal.review(change_id, action)
            if action == "undo":
                await self.storage.call(
                    "record_undo",
                    task["session_id"],
                    sorted({name for entry in journal.entries for name in entry["files"]}),
                    task["objective"],
                )
            await self.storage.call(
                "event",
                task_id,
                "CHANGE_REVIEWED",
                {
                    "task_id": task_id,
                    "change_id": change_id,
                    "action": action,
                },
            )
            return result

    async def _task_files(self, task_id: str) -> tuple[dict[str, Any], Path, list[str]]:
        """任务本身，以及它改过、且没有撤销的文件。"""
        task = await self.get_task(task_id)
        if task is None:
            raise InteractionError("任务不存在", 404)
        if self.git is None:
            raise InteractionError("当前运行服务没有启用 Git 提交", 501)
        root = Path(task["workspace_root"])
        journal = self.journal_factory(root, self.storage.directory / "artifacts" / task_id)
        files = sorted(
            {
                name
                for entry in journal.entries
                if entry["status"] != "undone"
                for name, record in entry["files"].items()
                if not record.get("undone")
            }
        )
        return task, root, files

    async def git_status(self, task_id: str) -> dict[str, Any]:
        _task, root, files = await self._task_files(task_id)
        return {**await self.git.status(root, files), "task_files": files}

    async def suggest_commit_message(self, task_id: str) -> dict[str, Any]:
        """用当前模型根据目标和差异写提交信息；模型不可用时给一个按目标生成的草稿。"""
        task, root, _files = await self._task_files(task_id)
        fallback = readable_objective(task["objective"], task.get("attachments")).splitlines()[0][
            :72
        ]
        changes = self.journal_factory(
            root, self.storage.directory / "artifacts" / task_id
        ).public()["changes"]
        diff = "\n".join(
            file["diff"]
            for change in changes
            if change["status"] != "undone"
            for file in change["files"]
        )[:12_000]
        if not diff:
            return {"message": fallback, "generated": False}
        try:
            from bit_agent.llm.client import get_configuration
            from bit_agent.llm.text import create_text

            client, main_model = get_configuration()
            model = auxiliary_model() or main_model
            text = await asyncio.to_thread(
                create_text,
                client,
                model=model,
                instructions=COMMIT_MESSAGE_INSTRUCTIONS,
                content=f"任务目标：{task['objective']}\n\n代码差异：\n{diff}",
                timeout=60,
            )
        except Exception as exc:
            failure("commit_message_failed", exc, level="warn", task_id=task_id)
            return {"message": fallback, "generated": False}
        message = text.strip().strip("`").strip()
        return {"message": message[:5000] or fallback, "generated": bool(message)}

    async def commit_changes(self, task_id: str, input: dict[str, Any]) -> dict[str, Any]:
        task, root, files = await self._task_files(task_id)
        if task["status"] not in TERMINAL:
            raise InteractionError("请先结束任务，再提交改动")
        message = input.get("message")
        branch = input.get("branch") or None
        if not isinstance(message, str) or not 1 <= len(message.strip()) <= 5000:
            raise InteractionError("请填写 1 到 5000 个字符的提交信息", 400)
        if branch is not None and (
            not isinstance(branch, str) or not BRANCH_NAME.fullmatch(branch)
        ):
            raise InteractionError("分支名只能包含字母、数字和 . _ / -", 400)
        if not files:
            raise InteractionError("这次任务没有需要提交的文件")
        # 与撤销相同：其他任务正在改这个目录时不提交，避免提交到一半的文件。
        async with self._workspaces.hold(root, wait=False):
            result = await self.git.commit(root, files, message.strip(), branch)
        await self.storage.call(
            "event",
            task_id,
            "CHANGES_COMMITTED",
            {"task_id": task_id, "commit": result["commit"], "branch": result["branch"]},
        )
        return result
