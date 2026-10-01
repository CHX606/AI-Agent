"""Tool contracts owned by the product, independent of execution adapters."""

VERIFY_SCHEMA = {
    "type": "function",
    "name": "verify_project",
    "description": "基础检查：根据真实修改运行项目已有测试和常规质量检查，"
    "失败时与修改前的版本对比，只把本轮新出现的失败算作未通过。"
    "outcome 为 PASSED、FAILED、UNVERIFIED（没有能运行的检查）或 NOT_APPLICABLE（只改了文档）。"
    "不生成测试，不判断业务需求是否满足；PASSED 后仍应调用 verify_task 独立验收。无需参数。",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}
