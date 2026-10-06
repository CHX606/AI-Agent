"""运行现有项目检查并比较本轮修改前的结果，不代替独立需求验收。"""

import tempfile
import time
from pathlib import Path

from bit_agent.security.paths import PathSecurityError
from bit_agent.tools.models import ToolResult

from .verification_support.comparison import compare_with_baseline as compare_with_baseline
from .verification_support.config import (
    VerificationConfigError as VerificationConfigError,
)
from .verification_support.config import (
    load_config as load_config,
)
from .verification_support.execution import VerificationExecution
from .verification_support.planning import (
    PYTHON_MARKERS as PYTHON_MARKERS,
)
from .verification_support.planning import (
    verification_plan as verification_plan,
)
from .verification_support.report import verification_report


def _plan(root: Path, changed: list[str], environment_root: Path | None) -> tuple[dict, list[dict]]:
    try:
        return verification_plan(root, changed, environment_root), []
    except (VerificationConfigError, PathSecurityError, OSError) as exc:
        return {"projects": [], "skipped": [], "unverifiable": []}, [
            {"paths": list(changed), "reason": f"验证配置无效：{exc}"}
        ]


async def verify_project(
    root: Path,
    changed: list[str],
    call_id: str,
    originals: dict[str, str | None] | None = None,
    *,
    environment_root: Path | None = None,
) -> ToolResult:
    """environment_root：root 是工作区副本时的原工作区，用来找项目自己的 .venv。"""
    started = time.monotonic()
    root = root.resolve()
    plan, errors = _plan(root, changed, environment_root and environment_root.resolve())
    comparable = (
        originals is not None
        and bool(originals)
        and all(name.replace("\\", "/").strip("/") in originals for name in changed)
    )
    with tempfile.TemporaryDirectory(prefix="bit-agent-baseline-") as temporary:
        run = VerificationExecution(root, call_id, originals, comparable, Path(temporary).resolve())
        run.unverified.extend(errors + plan["unverifiable"])
        await run.run_projects(plan["projects"])
    return verification_report(run, plan, changed, started)
