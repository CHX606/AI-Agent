import { execFile } from "node:child_process";

export type DockerStatus = "ready" | "not_installed" | "not_running";

/** 修改后的验证在 Docker 隔离环境中运行；提前告诉用户 Docker 是否可用。 */
export function dockerStatus(): Promise<DockerStatus> {
  return new Promise((resolve) => {
    execFile("docker", ["version", "--format", "{{.Server.Version}}"],
      { timeout: 10_000, windowsHide: true }, (error) => {
        if (!error) return resolve("ready");
        resolve((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_installed" : "not_running");
      });
  });
}
