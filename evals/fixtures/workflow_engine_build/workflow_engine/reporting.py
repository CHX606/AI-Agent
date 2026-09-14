"""工作流结果汇总与稳定文本报告。"""

from workflow_engine.models import StepStatus, WorkflowResult


def summarize(result: WorkflowResult) -> dict[StepStatus, int]:
    raise NotImplementedError


def render_text(result: WorkflowResult) -> str:
    raise NotImplementedError
