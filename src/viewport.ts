export type ViewportName = "desktop" | "mobile";

export interface ViewportProfile {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

export const VIEWPORT_PROFILES: Record<ViewportName, ViewportProfile> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

export function resolveViewport(name?: ViewportName): ViewportProfile {
  return VIEWPORT_PROFILES[name ?? "desktop"];
}
