/**
 * 内置浏览器地址栏：把用户输入变成要打开的地址。
 * - 本机地址（localhost、127.0.0.1、*.localhost、局域网 IP）默认 http，方便预览开发服务器；
 * - 像域名的输入补 https://；
 * - 其余当作搜索词；
 * - 只允许 http 和 https，其他协议（file:、javascript: 等）一律拒绝。
 */
export const SEARCH_URL = "https://www.bing.com/search?q=";

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|[\w-]+\.localhost|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(:\d{1,5})?(?:[/?#]|$)/iu;
const DOMAIN = /^[\w-]+(\.[\w-]+)+(:\d{1,5})?(?:[/?#]|$)/u;

export function isBrowsableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

export function browserAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(text)) {
    if (!isBrowsableUrl(text)) throw new Error("只能打开 http 或 https 地址");
    return new URL(text).href;
  }
  if (/^(javascript|data|file|vbscript|blob):/iu.test(text)) throw new Error("只能打开 http 或 https 地址");
  if (!/\s/u.test(text)) {
    if (LOCAL_HOST.test(text)) return new URL(`http://${text}`).href;
    if (DOMAIN.test(text)) return new URL(`https://${text}`).href;
  }
  return `${SEARCH_URL}${encodeURIComponent(text)}`;
}

/** 地址栏里显示的样子：去掉 http(s):// 和末尾单独的 /，搜索页显示搜索词。 */
export function displayAddress(url: string): string {
  if (url.startsWith(SEARCH_URL)) {
    const query = new URL(url).searchParams.get("q");
    if (query) return query;
  }
  return url.replace(/^https?:\/\//u, "").replace(/^([^/?#]+)\/$/u, "$1");
}
