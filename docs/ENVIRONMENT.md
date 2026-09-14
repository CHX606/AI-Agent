# 自动准备 Python 测试环境

运行 `run_tests` 或 `run_checks` 前，Harness 读取工作区根目录的依赖声明，自动构建依赖镜像，然后在无网络、只读、非 root 的测试容器中执行命令。CLI、Worker 和 MCP 共用此路径。

支持 `pyproject.toml` 的 `project.dependencies`、`project.optional-dependencies.dev/test`，以及 `requirements.txt`、`requirements-dev.txt`。只接受命名的 Python 包和版本约束；使用 PyPI wheel，不执行项目安装脚本，不支持源码包、URL、VCS、本地路径、pip 选项和递归 requirements。当前不自动处理 Node、其他依赖组或嵌套项目。

需要 OCR 系统环境时，可在项目 `pyproject.toml` 声明：

```toml
[tool.bit-agent.environment]
system-packages = ["tesseract-ocr", "tesseract-ocr-chi-sim"]
```

允许的系统包为 `tesseract-ocr`、`tesseract-ocr-chi-sim` 和 `tesseract-ocr-eng`。构建使用 Harness 生成的 Dockerfile，只传依赖清单，不传项目源码、`.env` 或凭据，也不执行项目自己编写的 Dockerfile。系统包依赖 Debian 基础镜像。

缓存名为 `bit-agent-env:<hash>`；hash 包含基础镜像 ID、规范化依赖和系统包列表。清单变化时构建新镜像，同进程并发请求共享构建锁。版本范围首次解析后随镜像缓存；需升级依赖时修改版本约束或移除对应缓存镜像。此缓存不是依赖锁文件。

环境准备独立超时为 300 秒，输出保留最后 16 KiB。安装失败作为沙盒启动错误返回工具调用，不能算作测试通过。构建阶段联网，测试阶段维持原有隔离。取消构建会终止本地构建客户端；已经下载的 Docker 层可能保留供后续复用。

`BIT_AGENT_SANDBOX_IMAGE` 选择可信基础镜像（须已构建、含 sandbox 用户和测试工具），`BIT_AGENT_AUTO_ENVIRONMENT=0` 可关闭自动准备。默认开启。首次构建可能较慢，Worker 总任务超时应包含构建耗时。
