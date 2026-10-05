/** 执行器自己的错误带上调用方给的随机串；被测命令不知道它，不能伪造“沙箱未启动”。 */
export function brokerErrorMarker(nonce: string | undefined): string {
  return `BIT_AGENT_SANDBOX_START_ERROR[${/^[a-f0-9]{32}$/u.test(nonce ?? "") ? nonce : ""}]: `;
}
