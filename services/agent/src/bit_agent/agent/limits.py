"""主任务的交互预算；客户端、Gateway 和运行时使用相同的默认值与范围。"""

DEFAULT_MAX_TOOL_ROUNDS = 100
MAX_TOOL_ROUNDS_LIMIT = 1000


def validate_max_tool_rounds(value: object) -> int:
    if type(value) is not int or not 1 <= value <= MAX_TOOL_ROUNDS_LIMIT:
        raise ValueError(f"最大交互轮数必须是 1–{MAX_TOOL_ROUNDS_LIMIT} 之间的整数")
    return value
