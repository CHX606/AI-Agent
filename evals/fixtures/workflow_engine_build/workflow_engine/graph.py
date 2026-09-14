"""依赖图校验和分析。"""

from workflow_engine.models import Workflow


def validate_workflow(workflow: Workflow) -> None:
    """校验完整工作流，不合法时抛出具体 WorkflowValidationError。"""
    raise NotImplementedError


def topological_layers(workflow: Workflow) -> tuple[tuple[str, ...], ...]:
    """返回可并行执行的稳定拓扑分层。"""
    raise NotImplementedError


def transitive_dependencies(workflow: Workflow, step_id: str) -> tuple[str, ...]:
    """按照原始步骤顺序返回指定步骤的全部传递依赖。"""
    raise NotImplementedError
