/** 对话流里每一项前面的圆点；颜色由所在条目的 data-tone 决定。 */
export function streamBullet(): HTMLSpanElement {
  const mark = document.createElement("span");
  mark.className = "stream-bullet";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "●";
  return mark;
}
