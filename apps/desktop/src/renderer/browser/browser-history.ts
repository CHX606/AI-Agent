/** 浏览历史和书签，存在本机（localStorage），用于地址栏建议和起始页。 */
import { displayAddress } from "../../shared/browser-address.js";

const HISTORY_KEY = "bit-agent.browser-history.v1";
const BOOKMARKS_KEY = "bit-agent.browser-bookmarks.v1";
const MAX_HISTORY = 300;

export interface HistoryEntry { url: string; title: string; visits: number; last: number }
export interface Bookmark { url: string; title: string }
export interface Suggestion { url: string; title: string; kind: "bookmark" | "history" }

function read<T>(key: string): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item) => typeof item?.url === "string") as T[] : [];
  } catch { return []; }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存不下就不记 */ }
}

export function history(): HistoryEntry[] { return read<HistoryEntry>(HISTORY_KEY); }
export function bookmarks(): Bookmark[] { return read<Bookmark>(BOOKMARKS_KEY); }

export function recordVisit(url: string, title: string, now = Date.now()): void {
  const entries = history();
  const existing = entries.find((entry) => entry.url === url);
  const entry = { url, title: title || existing?.title || displayAddress(url), visits: (existing?.visits ?? 0) + 1, last: now };
  // 访问次数少、时间久的先被挤掉。
  const kept = [entry, ...entries.filter((item) => item.url !== url)]
    .sort((a, b) => b.last - a.last).slice(0, MAX_HISTORY);
  write(HISTORY_KEY, kept);
}

export function recentVisits(limit = 6): HistoryEntry[] {
  return history().sort((a, b) => b.last - a.last).slice(0, limit);
}

export function isBookmarked(url: string): boolean { return bookmarks().some((item) => item.url === url); }

export function toggleBookmark(url: string, title: string): boolean {
  const list = bookmarks();
  if (list.some((item) => item.url === url)) {
    write(BOOKMARKS_KEY, list.filter((item) => item.url !== url));
    return false;
  }
  write(BOOKMARKS_KEY, [{ url, title: title || displayAddress(url) }, ...list].slice(0, 100));
  return true;
}

/** 地址栏建议：书签优先，其次按访问次数和最近访问排序；标题或地址包含输入的每个词。 */
export function suggestions(query: string, limit = 7, now = Date.now()): Suggestion[] {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  const matches = (url: string, title: string) => {
    const text = `${displayAddress(url)} ${title}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const marked = bookmarks().filter((item) => matches(item.url, item.title))
    .map((item) => ({ url: item.url, title: item.title, kind: "bookmark" as const }));
  const seen = new Set(marked.map((item) => item.url));
  const score = (entry: HistoryEntry) => entry.visits * 2 + Math.max(0, 30 - (now - entry.last) / 86_400_000);
  const visited = history().filter((entry) => !seen.has(entry.url) && matches(entry.url, entry.title))
    .sort((a, b) => {
      // 网址以输入开头的排在前面（输入 local 时 localhost:5173 比标题里含 local 的更像要找的）。
      const prefix = (entry: HistoryEntry) => Number(displayAddress(entry.url).toLowerCase().startsWith(words[0]!));
      return prefix(b) - prefix(a) || score(b) - score(a);
    })
    .map((entry) => ({ url: entry.url, title: entry.title, kind: "history" as const }));
  return [...marked, ...visited].slice(0, limit);
}
