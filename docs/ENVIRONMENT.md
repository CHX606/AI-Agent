# Windows OS 沙箱

当前 Windows 桌面版使用锁定的 `@anthropic-ai/sandbox-runtime@0.0.78` 官方运行库，不再构建 Docker 测试镜像。该 SDK 的 Windows 支持由官方标为 alpha。

运行 `run_tests`、`run_checks`、仓库验证和独立验收时，命令以独立的 `srt-sandbox` 系统账户运行在受限进程树里。首次执行可能需要 Windows 授权，用官方安装器创建账户和针对其 SID 的 WFP 网络过滤规则。每次执行前 SDK 都验证网络隔离；初始化失败时不会退回普通进程执行，结果记为“无法验证”。

## 能做什么、不能做什么

| 范围 | 沙箱里的命令 |
| --- | --- |
| 网络 | 禁止，包括本机端口 |
| 写入 | 选定的工作区。工作区里的 `.git`、`.venv`、`node_modules`、`.bit-agent`、`.codex`、`.agents`、`.claude`、`.vscode`、`.idea`、`.mcp.json` 和密钥文件不能改；根目录的 `.bit-agent` 还不存在时也不能新建 |
| 读取 | 工作区及其上一级目录、项目命令和 Python 所在目录、沙箱执行器目录；`.env`、`.ssh`、`*.pem`、`*.key` 等密钥文件不能读 |
| 同时运行 | 整台电脑同一时间只跑一个沙箱命令，其他排队；同一个 Bit Agent 内排队的时间不算进超时 |

上一级目录要开放读取：pytest 收集测试时会读取工作区上一级目录的属性，工作区放在“桌面”“文档”这类私有文件夹下时，不开放会直接报“拒绝访问”。官方 SDK 只能授予连同子目录一起生效的读权限，所以和工作区同级的其他文件夹也能读到。

### Windows 自身权限的限制

`srt-sandbox` 是一个普通的 Windows 用户。上表是 Bit Agent 额外授予或拒绝的权限；Windows 本来就允许所有用户访问的文件夹，它同样可以访问。

- 用户目录（`C:\Users\<你>`）下默认只有你自己能访问，沙箱只能碰到上表列出的部分。
- 非系统盘（例如 `D:\`）和直接建在 `C:\` 下的文件夹，Windows 默认给“Authenticated Users”修改权限。不加固时，沙箱命令可以读写这些位置的其他文件，包括别的项目和装在那里的工具链。

Codex 的 Windows 沙箱也有同样的提示：对所有人开放的文件夹，沙箱无法完全保护。

### 加固：禁止沙箱改写这些文件夹

`scripts/harden-sandbox.ps1` 找出对所有用户开放写入的文件夹（非系统盘根目录、`C:\` 下自建的文件夹），给官方安装器创建的 `sandbox-runtime-users` 组加一条可继承的“拒绝写入”（写、追加、改属性、删除、改权限、改所有者）。每次检查时 Bit Agent 给工作区的显式授权排在继承来的拒绝前面，所以工作区照常可写，工作区以外的文件不能再被改动或删除。

```powershell
# 先预览，不做修改
powershell -ExecutionPolicy Bypass -File scripts\harden-sandbox.ps1
# 以管理员身份执行加固；只加固指定位置时加 -Path D:\,C:\DevTools
powershell -ExecutionPolicy Bypass -File scripts\harden-sandbox.ps1 -Apply
# 撤销
powershell -ExecutionPolicy Bypass -File scripts\harden-sandbox.ps1 -Remove
```

- 拒绝挂在组上而不是 `srt-sandbox` 用户上：官方 `srt-win` 每次运行都会改写并清理“沙箱用户”的权限项，挂在用户上会在第一次检查后被抹掉。官方 SDK 自己也用这个组的显式拒绝保护它的状态目录。
- 拒绝不含 `SYNCHRONIZE`，否则沙箱连目录都打不开（pytest 向上查找配置会失败），所以脚本用 .NET 写入，不用 `icacls /deny`。
- Windows 会把权限写到整棵目录树：实测约每秒 6000 个文件，一百五十万个文件的盘大约 4–5 分钟。撤销同样需要遍历。
- 只拒绝写入，读取不变：这些位置对沙箱仍然可读，测试输出可能把读到的内容带给模型。
- 新建的盘或新建在 `C:\` 下的文件夹不会自动加固，重新运行脚本即可；重装官方沙箱后组会重建，预览会显示“未加固”。

## 和改动审阅的关系

测试、检查和独立验收在“逐次确认”和“允许修改”模式下直接运行，不弹审批；“只读模式”下不运行。这与 Claude Code（沙箱 auto-allow 模式）和 Codex（默认的 Auto 模式）一致：沙箱内的命令自动运行，越过沙箱边界才需要确认。

单独调用的 `run_tests`、`run_checks` 直接在工作区里运行，它们自己产生的文件改动直接留在工作区，不进入“审阅改动”，也不能用“撤销这次改动”还原。Claude Code 的检查点同样不记录 Shell 命令改动的文件，Codex 依靠 Git 回退。建议在 Git 仓库里使用，需要时用 Git 还原。

## 工作区和依赖

基础检查（`verify_project`）、失败原因对比和独立验收都在私有临时目录的安全副本里运行，不改你的工作区；副本过滤凭据、虚拟环境（`.venv`）及依赖目录（`node_modules`）。单独调用的 `run_tests`、`run_checks` 直接在选定的工作区里运行，优先使用项目 `.venv`，没有时使用 Agent 自带的 Python。Node 使用项目现有 npm/pnpm 脚本。项目依赖和工具链需要预先准备，验证时禁网且不自动安装依赖。

Node 项目放在用户目录深处（例如 `AppData`、`Temp` 下）时，Node 读取上级目录信息可能返回 EPERM；这一限制没有通过扩大用户目录权限绕过。

## 执行与清理

沙箱执行器位于工作区外的校验缓存，临时读写授权在命令退出时回收。超时或取消先通知执行器，等待官方进程树终止和权限清理；清理不能确认时如实记录失败。执行器自己的错误带有每次随机生成的标记，被测命令打印同样的文字不会被当成“沙箱未启动”。

不再使用 `BIT_AGENT_SANDBOX_IMAGE`、`BIT_AGENT_AUTO_ENVIRONMENT`、`.bit-agent/verify.json` 的 `image` 字段或 `tool.bit-agent.environment.system-packages`。便携包携带固定版本的 SDK helper、Node 执行器和 Python 验证工具；没有新增沙箱配置入口。
