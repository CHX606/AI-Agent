/**
 * 写给用户看的错误，例如“请填写 API Key”“服务名重复”。IPC 会把原文交给页面；
 * 其他异常可能带内部细节，只显示通用提示和诊断编号。
 */
export class UserFacingError extends Error {
  readonly userFacing = true;
}

export function isUserFacing(error: unknown): error is Error {
  return error instanceof Error && (error as { userFacing?: unknown }).userFacing === true;
}
