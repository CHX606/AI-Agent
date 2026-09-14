"""提供给模型的 Bit Agent Function Calling Schema。"""

TOOL_SCHEMAS = [
    {
        "type": "function",
        "name": "list_files",
        "description": (
            "列出工作区指定目录下的文件和子目录，不读取文件内容。"
            "查看工作区根目录时必须先使用 max_depth=0，之后再进入需要的具体目录"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对于工作区根目录的目录路径；查看根目录时传入空字符串",
                },
                "max_depth": {
                    "type": "integer",
                    "enum": [0, 1, 2, 3, 4, 5],
                    "description": (
                        "递归深度。0 表示只列出目标目录的直接子项；"
                        "应先浅层查看，再按需要进入具体目录"
                    ),
                },
            },
            "required": ["path", "max_depth"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "read_file",
        "description": (
            "按行号范围读取工作区内的 UTF-8 文本文件，返回带行号的文本。"
            "只能读取文件，不能读取目录。单次最多 500 行，且仍受输出字节上限限制。"
            "搜索定位后可读取匹配行附近；需要后续内容时调整行号，不要重复读取相同范围"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对于工作区根目录的文件路径",
                },
                "start_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "起始行号，从 1 开始，包含该行；从文件开头读取时填 1",
                },
                "end_line": {
                    "type": ["integer", "null"],
                    "minimum": 1,
                    "description": (
                        "结束行号，包含该行；不得小于 start_line，范围最多 500 行。"
                        "填 null 表示从 start_line 起最多读取 500 行，不代表读取到文件末尾"
                    ),
                },
            },
            "required": ["path", "start_line", "end_line"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "search_code",
        "description": (
            "使用 ripgrep 正则表达式在工作区代码中搜索匹配内容，"
            "返回文件路径、行号、列号和匹配文本。"
            "括号等正则特殊字符需要使用反斜杠转义。"
            "结果截断时请调整关键词、路径或 glob，不要原样重复搜索；不支持自动翻页"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "要搜索的文本或正则表达式",
                },
                "path": {
                    "type": "string",
                    "description": "搜索范围；相对于工作区根目录，搜索整个工作区时传空字符串",
                },
                "glob": {
                    "type": ["string", "null"],
                    "description": "文件名或路径过滤，例如 *.py；不额外过滤时填 null",
                },
                "max_results": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 200,
                    "description": (
                        "最多返回的匹配行数，通常填 50；"
                        "可按需调整为 1–200，仍受字节上限限制"
                    ),
                },
            },
            "required": ["query", "path", "glob", "max_results"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "run_tests",
        "description": (
            "在受控沙箱中运行指定的 pytest 测试文件或测试目录，返回退出码、标准输出和错误输出"
            "。Harness 自动安装根目录 pyproject.toml 的 dependencies、dev/test extras，"
            "以及 requirements.txt、requirements-dev.txt 中的命名 Python 依赖。"
            "只支持 wheel，不支持 URL、本地路径或源码安装。OCR 系统包可在 "
            "[tool.bit-agent.environment] 的 system-packages 列表声明 "
            "tesseract-ocr、tesseract-ocr-chi-sim、tesseract-ocr-eng"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": (
                        "相对于工作区根目录的测试文件或测试目录，"
                        "例如 tests 或 tests/test_example.py"
                    ),
                },
            },
            "required": ["target"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "run_checks",
        "description": (
            "在受控 Docker 沙箱中对指定路径运行白名单检查。"
            "修改代码后必须对本轮所有修改文件运行 lint；项目提供类型配置或构建配置时，"
            "还应按需运行 typecheck 或 build。不能执行任意 Shell 命令"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "check": {
                    "type": "string",
                    "enum": ["lint", "format", "typecheck", "build"],
                    "description": (
                        "lint=Ruff 静态检查；format=Ruff 格式检查；"
                        "typecheck=mypy 类型检查；build=构建 Python 包"
                    ),
                },
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 100,
                    "description": (
                        "相对于工作区根目录的检查路径。lint 必须覆盖本轮所有修改文件；"
                        "build 只能传一个项目目录，根目录用空字符串"
                    ),
                },
            },
            "required": ["check", "paths"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "apply_patch",
        "description": (
            "向工作区安全地应用补丁，用于创建、修改或删除文件。"
            "接受标准 Git unified diff，也接受由 *** Begin Patch 和 *** End Patch 包裹，"
            "并使用 *** Add File、*** Update File 或 *** Delete File 的补丁格式。"
            "Update File 的 @@ 区块应提供足够上下文，使修改位置只能匹配一处。"
            "调用前应先读取相关代码，并确保补丁路径位于工作区内。"
            "为避免模型响应超时，每次调用只处理一小批紧密相关的文件，"
            "建议不超过 3 个文件；较大的新项目必须拆成多轮补丁"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "patch": {
                    "type": "string",
                    "description": (
                        "完整、有效的 UTF-8 补丁文本；可使用 Git unified diff，"
                        "或 Begin Patch 的 Add、Update、Delete File 格式。"
                        "单次补丁建议不超过 3 个紧密相关文件，大改动应拆分调用"
                    ),
                },
            },
            "required": ["patch"],
            "additionalProperties": False,
        },
        "strict": True,
    },
]
