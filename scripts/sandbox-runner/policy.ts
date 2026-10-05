import { win32 as path } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRequest } from "./request.js";

const secretPatterns = [
  "**/.env", "**/.env.*", "**/.ssh", "**/id_rsa", "**/id_dsa",
  "**/id_ecdsa", "**/id_ed25519", "**/*.key", "**/*.pem", "**/*.p12", "**/*.pfx",
];
// 与 Codex / Claude Code 一致：命令可以写工作区，但不能改 Git 元数据、依赖目录和 Agent / 编辑器配置。
const protectedPatterns = [
  "**/.git", "**/.venv", "**/node_modules", "**/.mcp.json",
  "**/.bit-agent", "**/.codex", "**/.agents", "**/.claude", "**/.vscode", "**/.idea",
];
// 验证配置在根目录还不存在时也要保护；结尾分隔符让官方 SDK 以空目录占位并拒绝写入。
const rootConfigDirectories = [".bit-agent\\"];

export function sandboxPolicy(request: SandboxRequest, helper: string, broker: string): SandboxRuntimeConfig {
  // pytest 收集时会 stat 工作区的上级目录；官方 SDK 只能授予可继承的读权限，所以上级目录整体可读。
  // 工作区在用户目录内的私有文件夹下时，不开放上级目录 pytest 会直接报“拒绝访问”。
  const roots = [...new Set([request.workspace, path.dirname(request.workspace), path.dirname(helper), ...request.readPaths])];
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true, allowLocalBinding: false },
    filesystem: {
      allowWrite: [request.workspace], allowRead: roots,
      denyRead: roots.flatMap(root => secretPatterns.map(pattern => path.join(root, pattern))),
      denyWrite: [
        ...protectedPatterns.map(pattern => path.join(request.workspace, pattern)),
        ...rootConfigDirectories.map(directory => path.join(request.workspace, directory)),
        ...secretPatterns.map(pattern => path.join(request.workspace, pattern)),
        path.dirname(helper), path.dirname(broker), path.dirname(process.execPath),
      ],
    },
    windows: { srtWin: { path: helper } },
  };
}
