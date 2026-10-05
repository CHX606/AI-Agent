import { checkWindowsSandboxStatusAsync, resolveSrtWin, type WindowsSandboxStatus } from "@anthropic-ai/sandbox-runtime";

export interface BrokerStatus { available: boolean; backend: "anthropic-windows"; version: "0.0.78"; message: string }

export function describeStatus(status: WindowsSandboxStatus): BrokerStatus {
  const base = { backend: "anthropic-windows" as const, version: "0.0.78" as const };
  if (!status.user.provisioned) return { ...base, available: false, message: "官方 Windows 沙箱尚未安装，首次执行需要系统授权。" };
  if (!status.user.credPresent) return { ...base, available: false, message: "官方沙箱账户凭据不可用，请修复官方安装。" };
  if (status.wfp.state === "absent") return { ...base, available: false, message: "官方沙箱网络过滤器缺失，请修复官方安装。" };
  if (status.wfp.state === "cannot-read") {
    return { ...base, available: true, message: "账户凭据已就绪；当前权限无法枚举 WFP，执行前由官方 SDK 验证网络隔离。" };
  }
  return { ...base, available: true, message: "官方账户凭据和 WFP 过滤器已就绪，执行前由官方 SDK 验证网络隔离。" };
}

export async function brokerStatus(): Promise<BrokerStatus> {
  const base = { backend: "anthropic-windows" as const, version: "0.0.78" as const };
  try {
    if (process.platform !== "win32") throw new Error("当前原生沙箱仅支持 Windows");
    const helper = process.env.BIT_AGENT_SANDBOX_EXECUTABLE;
    if (!helper) throw new Error("随程序验证的 Windows 沙箱 helper 不可用");
    const status = await checkWindowsSandboxStatusAsync({ srtWin: resolveSrtWin({ path: helper }) });
    return describeStatus(status);
  } catch (error) {
    return { ...base, available: false, message: String(error) };
  }
}
