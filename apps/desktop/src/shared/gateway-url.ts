const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function normalizeGatewayUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Gateway 地址只允许 http 或 https");
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("远程 Gateway 必须使用 https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Gateway 地址不能包含用户名或密码");
  }
  return parsed.origin;
}
