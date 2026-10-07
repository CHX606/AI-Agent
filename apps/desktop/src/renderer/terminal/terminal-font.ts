import "./terminal-font.css";

export const TERMINAL_FONT = '"MesloLGS Nerd Font Mono", "Microsoft YaHei UI", monospace';
export const FALLBACK_TERMINAL_FONT = 'Consolas, "Microsoft YaHei UI", monospace';

/** xterm 首次测量必须在字体加载后进行，避免按 fallback 字宽换行。 */
export async function loadTerminalFont(fontSize: number): Promise<void> {
  const faces = await document.fonts.load(`${fontSize}px "MesloLGS Nerd Font Mono"`);
  if (!faces.length) throw new Error("终端字体资源未加载");
  await document.fonts.ready;
}
