"""工作流定义错误。"""


class WorkflowValidationError(ValueError):
    """所有工作流校验错误的基类。"""


class EmptyWorkflowError(WorkflowValidationError):
    pass


class InvalidStepError(WorkflowValidationError):
    pass


class DuplicateStepError(WorkflowValidationError):
    pass


class UnknownDependencyError(WorkflowValidationError):
    pass


class DuplicateDependencyError(WorkflowValidationError):
    pass


class SelfDependencyError(WorkflowValidationError):
    pass


class WorkflowCycleError(WorkflowValidationError):
    pass
