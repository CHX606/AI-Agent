export const sidebarWidthKey = "bit-agent.sidebar-width.v1";

export function sidebarWidthLimits(viewport: number, inspector: number) {
  const maximum = Math.min(520, Math.max(180, viewport - inspector - 480));
  return { minimum: 180, maximum };
}

export function fitSidebarWidth(width: number, viewport: number, inspector: number): number {
  const { minimum, maximum } = sidebarWidthLimits(viewport, inspector);
  return Math.round(Math.min(maximum, Math.max(minimum, width)));
}

export function storedSidebarWidth(value: string | null): number | null {
  if (value === null || !value.trim()) return null;
  const width = Number(value);
  return Number.isFinite(width) && width >= 180 && width <= 520 ? width : null;
}
