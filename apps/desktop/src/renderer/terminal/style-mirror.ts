/**
 * xterm.js 用动态 <style> 元素设置配色和字符尺寸，但页面的 CSP（style-src 'self'）会拦掉内联样式。
 * 这里只把终端区域内 xterm 自己生成的 <style> 内容复制到构造样式表（adoptedStyleSheets）中生效，
 * 全局 CSP 保持不变：模型输出里的内联样式仍然被拦截。
 */
export function mirrorInjectedStyles(root: HTMLElement): void {
  const sheets = new Map<HTMLStyleElement, CSSStyleSheet>();
  const sync = () => {
    for (const element of root.querySelectorAll("style")) {
      let sheet = sheets.get(element);
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheets.set(element, sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      sheet.replaceSync(element.textContent ?? "");
    }
    for (const [element, sheet] of sheets) {
      if (root.contains(element)) continue;
      sheets.delete(element);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== sheet);
    }
  };
  new MutationObserver(sync).observe(root, { subtree: true, childList: true, characterData: true });
  sync();
}
