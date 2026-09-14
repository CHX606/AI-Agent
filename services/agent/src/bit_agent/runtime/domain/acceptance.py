"""Independent acceptance contracts. A model opinion is not execution evidence."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

AcceptanceStatus = Literal["NOT_RUN", "PASSED", "FAILED", "NOT_VERIFIED"]


class AcceptanceCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requirement: str = Field(min_length=1, max_length=2000)
    status: Literal["PASSED", "FAILED", "NOT_VERIFIED"]
    evidence_ids: list[str] = Field(max_length=30)


class AcceptanceReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: Literal["PASSED", "FAILED", "NOT_VERIFIED"]
    summary: str = Field(min_length=1, max_length=4000)
    checks: list[AcceptanceCheck] = Field(min_length=1, max_length=50)
    unverified: list[str] = Field(max_length=50)


VERIFY_TASK_SCHEMA = {
    "type": "function",
    "name": "verify_task",
    "description": (
        "启动独立测试 Agent，根据用户原始需求和真实改动验收。"
        "先调用 verify_project 做基础检查，再调用本工具。"
        "测试 Agent 在隔离副本补写测试并执行，不修改原项目。"
        "focus 仅为建议关注点，不能替代用户需求。会额外调用模型。"
    ),
    "parameters": {
        "type": "object",
        "properties": {"focus": {"type": "string", "maxLength": 4000}},
        "required": ["focus"],
        "additionalProperties": False,
    },
}


def tester_schema(name: str, description: str, properties: dict) -> dict:
    return {
        "type": "function",
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
    }


TESTER_SCHEMAS = [
    tester_schema(
        "write_acceptance_test",
        "在隔离副本新增或更新本次自己编写的测试，不能修改业务代码、配置或已有测试。"
        "project 为项目相对目录（根目录用空字符串），filename 只填文件名。"
        "Python 使用 test_*.py；Node 使用 *.test.js/ts/tsx/mjs/cjs。返回实际测试路径。",
        {
            "project": {"type": "string"},
            "filename": {"type": "string"},
            "content": {"type": "string", "maxLength": 64000},
        },
    ),
    tester_schema(
        "run_acceptance_test",
        "在断网隔离容器中执行指定测试。project 是项目相对目录；target 是相对于该项目的"
        "测试文件/目录，空字符串运行项目测试集。Python 用 pytest，Node 用现有 test 脚本。"
        "只接受路径，不接受 shell 命令。Node 脚本须支持透传测试路径，否则报告未验证。",
        {
            "project": {"type": "string"},
            "target": {"type": "string"},
            "language": {"type": "string", "enum": ["python", "node"]},
        },
    ),
    {
        "type": "function",
        "name": "submit_acceptance_report",
        "description": "提交逐项验收报告。通过项必须引用本轮工具实际返回的 evidence_id；"
        "补写测试后必须重新执行。未运行、环境不支持或无法覆盖的需求标记 NOT_VERIFIED。",
        "parameters": AcceptanceReport.model_json_schema(),
    },
]
