/** 内置浏览器在窗口里的位置（CSS 像素，相对窗口内容区）。 */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTab {
  id: string;
  title: string;
  /** 空字符串表示新标签页（显示起始页）。 */
  url: string;
  loading: boolean;
  favicon: string | null;
  /** Agent 正在使用的标签页。 */
  agent?: boolean;
}

/** 整个浏览器的状态；url 等字段描述当前标签页。 */
export interface BrowserState {
  tabs: BrowserTab[];
  activeId: string | null;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 缩放比例，1 为 100%。 */
  zoom: number;
  /** 加载失败时的说明；成功加载后清空。certificate 为 true 时可以选择继续访问。 */
  error: { code: number; description: string; url: string; certificate?: boolean } | null;
  /** 网页进入了 HTML 全屏（例如视频全屏），这时视图铺满整个窗口。 */
  fullscreen: boolean;
}

/** 网页向用户提出的请求：权限或登录。 */
export type BrowserPrompt =
  | { id: string; kind: "permission"; origin: string; permission: string; label: string }
  | { id: string; kind: "login"; origin: string; realm: string; proxy: boolean };

export type BrowserPromptAnswer = { allow: boolean } | { username: string; password: string } | { cancel: true };

export interface BrowserDownload {
  id: string;
  filename: string;
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  received: number;
  total: number;
  /** 可执行文件（.exe、.bat 等）只提供“在文件夹中显示”，不直接打开。 */
  executable: boolean;
}

export type BrowserAction = "back" | "forward" | "reload" | "stop" | "devtools" | "external"
  | "zoom-in" | "zoom-out" | "zoom-reset" | "print";

/** 浏览器页面里按下、需要交给应用处理的快捷键。 */
export type BrowserShortcut = "focus-address" | "toggle-sidebar" | "toggle-terminal" | "find"
  | "new-tab" | "close-tab" | "next-tab" | "previous-tab" | "bookmark";
