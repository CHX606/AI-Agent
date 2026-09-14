# Docker Desktop 启动修复

更新日期：2026-09-07。

## 这个文件夹做什么

这里放 Windows 下辅助启动 Docker Desktop 的脚本。它处理的是“Docker 自己没正常起来”的问题，业务代码和 Agent 的测试逻辑不在这里。

`start-docker-desktop.ps1` 是 PowerShell 脚本；本文件是解释它怎样工作的说明。脚本位于本项目中，但它检查和处理的是本机 Docker 的运行状态。

它不会负责启动 Redis、Gateway、Worker 或 Bit Agent 桌面窗口。Redis 和数据库配置在 [infra 总说明](../README.md) 中。

## 什么时候用

正常启动 Docker Desktop 就能使用时，不需要把它当成每次必做步骤。遇到下文描述的残留通信文件问题时，可以使用这个入口。

脚本默认安装路径是 `C:/Program Files/Docker/Docker/Docker Desktop.exe`，默认等待 Engine 就绪时间为 120 秒；安装位置不同时需要按实际环境处理。

Windows 异常关机、休眠或强制结束 Docker Desktop 时，可能遗留无法删除的 AF_UNIX socket，
导致下次启动报错 `The file cannot be accessed by the system`。

当前入口同时处理 `Docker/run` 中的 `sailor-ingest.sock` 等运行文件，以及
`docker-secrets-engine/engine.sock`。部分 Docker 辅助组件可能在旧目录移动后立即重建
一个空目录；脚本会接受这个安全结果，不会再因为目录创建竞态中断。

使用项目提供的安全启动入口：

```powershell
pwsh -File infra/docker/start-docker-desktop.ps1
```

脚本会先检查 Docker Engine：Engine 正常时直接退出；Engine 异常但 Docker Desktop
仍在运行时，先用官方 `docker desktop stop` 命令停止异常实例。只有确认相关进程已经
停止并发现残留 socket 后，才会把父目录移动成带时间戳的可恢复备份，再启动 Docker
Desktop 并等待 Engine 就绪。无法正常停止时会中止并要求从界面选择 Quit，不会强制
杀进程。

脚本不会删除镜像、容器、Volume 或项目文件。

上游问题：<https://github.com/docker/desktop-feedback/issues/554>
