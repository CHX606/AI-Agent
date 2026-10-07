import { type ITheme } from "@xterm/xterm";

const ansi = {
  light: { black: "#262624", red: "#c84b45", green: "#3d9140", yellow: "#a87a12", blue: "#3973b8", magenta: "#9a4fb0",
    cyan: "#2b8a94", white: "#7b7b74", brightBlack: "#5c5c57", brightRed: "#d9625b", brightGreen: "#4fa752",
    brightYellow: "#b98a1c", brightBlue: "#4b86cc", brightMagenta: "#ad62c2", brightCyan: "#36a0ab", brightWhite: "#9a9a92" },
  dark: { black: "#3a3a36", red: "#df7b74", green: "#7cbd7d", yellow: "#d8b45f", blue: "#7eabd5", magenta: "#c79ad6",
    cyan: "#6fc0c6", white: "#d6d3cb", brightBlack: "#77746c", brightRed: "#eb948e", brightGreen: "#96cf97",
    brightYellow: "#e6c77a", brightBlue: "#9cc0e3", brightMagenta: "#d6b2e2", brightCyan: "#8fd0d5", brightWhite: "#f4f2ec" },
} satisfies Record<string, ITheme>;

export function themeFromPage(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string) => style.getPropertyValue(name).trim();
  const dark = document.documentElement.dataset.theme === "dark";
  return { ...ansi[dark ? "dark" : "light"], background: value("--bg-main"), foreground: value("--text"),
    cursor: value("--brand"), cursorAccent: value("--bg-main"), selectionBackground: value("--selection") };
}
