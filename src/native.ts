import { invoke } from '@tauri-apps/api/core';

export type NavigationAction = 'back' | 'forward' | 'reload' | 'stop';

export interface SiteState {
  url: string;
  canGoBack: boolean | null;
  canGoForward: boolean | null;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface SiteConfiguration extends ViewportSize {
  userAgent: string;
  landscape: boolean;
  scale: number;
  session: number;
}

export const nativeBrowser = {
  prepare: () => invoke<void>('configure_interface'),
  navigate: (url: string) => invoke<void>('navigate_site', { url }),
  configure: (options: SiteConfiguration) => invoke<void>('configure_site', { options }),
  action: (action: NavigationAction) => invoke<void>('site_action', { action }),
  resize: ({ width, height }: ViewportSize, landscape: boolean, scale: number) =>
    invoke<void>('resize_site', { width, height, landscape, scale }),
  snapshot: () => invoke<string>('site_snapshot'),
  exportSnapshot: () => invoke<string>('export_snapshot'),
  state: () => invoke<SiteState>('site_state'),
};

export function mobileUserAgent(): string {
  const version = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'Chrome/125.0.0.0';
  return `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) ${version} Mobile Safari/537.36`;
}
