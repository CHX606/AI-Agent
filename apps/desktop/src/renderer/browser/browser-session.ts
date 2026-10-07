import type { BrowserState } from "../../shared/contracts.js";
import { tabTitle } from "./browser-tabs.js";

const TABS_KEY = "bit-agent.browser-tabs.v1";
interface SavedTabs { tabs: { url: string; title: string }[]; active: number }

function savedTabs(): SavedTabs | null {
  try { return JSON.parse(localStorage.getItem(TABS_KEY) ?? "null") as SavedTabs | null; }
  catch (error) { console.warn("无法读取已保存的浏览器标签页", error); return null; }
}

export class BrowserSession {
  private restored = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly current: () => BrowserState, private readonly apply: (state: BrowserState) => void) {}

  save(): void {
    if (!this.restored) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 400);
  }

  private persist(): void {
    const state = this.current();
    const tabs = state.tabs.filter((tab) => tab.url).map((tab) => ({ url: tab.url, title: tabTitle(tab) }));
    const active = Math.max(0, tabs.findIndex((tab) => tab.url === state.url));
    try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active } satisfies SavedTabs)); }
    catch (error) { console.warn("无法保存浏览器标签页", error); }
  }

  /** 页面重新加载时接回主进程已有标签；重新启动时只加载之前的当前页。 */
  async restore(): Promise<void> {
    if (this.restored) return;
    const state = await window.bitAgent.getBrowserState();
    this.apply(state);
    const saved = savedTabs();
    const tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter((tab) => typeof tab?.url === "string").slice(0, 20) : [];
    if (!state.tabs.length) await this.restoreSaved(tabs, saved?.active);
    this.restored = true;
  }

  private async restoreSaved(tabs: SavedTabs["tabs"], active: number | undefined): Promise<void> {
    for (const [index, tab] of tabs.entries()) {
      await window.bitAgent.newBrowserTab(tab.url, { lazy: true, activate: index === active, title: tab.title });
    }
  }
}
