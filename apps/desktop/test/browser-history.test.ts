import { beforeEach, expect, it } from "vitest";

const store = new Map<string, string>();
Object.assign(globalThis, { localStorage: {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
} });

const { bookmarks, isBookmarked, recentVisits, recordVisit, suggestions, toggleBookmark } = await import("../src/renderer/browser/browser-history");

beforeEach(() => store.clear());

it("records visits, counts repeats and lists the most recent first", () => {
  recordVisit("http://localhost:5173/", "Vite App", 1000);
  recordVisit("https://docs.example.com/guide", "Guide", 2000);
  recordVisit("http://localhost:5173/", "", 3000);
  expect(recentVisits().map((entry) => [entry.url, entry.title, entry.visits])).toEqual([
    ["http://localhost:5173/", "Vite App", 2],
    ["https://docs.example.com/guide", "Guide", 1],
  ]);
});

it("toggles bookmarks", () => {
  expect(toggleBookmark("https://example.com/", "Example")).toBe(true);
  expect(isBookmarked("https://example.com/")).toBe(true);
  expect(bookmarks()).toEqual([{ url: "https://example.com/", title: "Example" }]);
  expect(toggleBookmark("https://example.com/", "Example")).toBe(false);
  expect(bookmarks()).toEqual([]);
});

it("suggests bookmarks first, then history whose address starts with the input", () => {
  const now = 10 * 86_400_000;
  recordVisit("https://blog.example.com/local-first", "Local-first software", now - 1000);
  recordVisit("https://blog.example.com/local-first", "Local-first software", now - 900);
  recordVisit("http://localhost:3000/", "Next app", now - 5 * 86_400_000);
  toggleBookmark("http://localhost:5173/", "Vite dev");
  expect(suggestions("local", 7, now).map((item) => [item.kind, item.url])).toEqual([
    ["bookmark", "http://localhost:5173/"],
    ["history", "http://localhost:3000/"],
    ["history", "https://blog.example.com/local-first"],
  ]);
  expect(suggestions("next app", 7, now).map((item) => item.url)).toEqual(["http://localhost:3000/"]);
  expect(suggestions("   ", 7, now)).toEqual([]);
});

it("deduplicates stored history and bookmarks by normalized address without merging distinct searches", () => {
  store.set("bit-agent.browser-history.v1", JSON.stringify([
    { url: "https://example.com", title: "Older", visits: 1, last: 1000 },
    { url: "https://example.com/", title: "Newest", visits: 2, last: 3000 },
    { url: "https://example.com/search?q=one", title: "Search", visits: 1, last: 2000 },
    { url: "https://example.com/search?q=two", title: "Search", visits: 1, last: 1500 },
  ]));
  store.set("bit-agent.browser-bookmarks.v1", JSON.stringify([
    { url: "https://example.com", title: "Example" },
    { url: "https://example.com/", title: "Duplicate" },
  ]));
  expect(recentVisits().map((entry) => entry.title)).toEqual(["Newest", "Search", "Search"]);
  expect(bookmarks()).toEqual([{ url: "https://example.com", title: "Example" }]);
});
