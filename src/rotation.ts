import { LogicalSize } from '@tauri-apps/api/dpi';
import type { Window } from '@tauri-apps/api/window';
import { WINDOW_SIZE, type Orientation } from './config';

export async function resizeWindow(appWindow: Window | null, to: Orientation): Promise<void> {
  if (!appWindow) return;
  const { width, height } = WINDOW_SIZE[to];
  await appWindow.setSize(new LogicalSize(width, height));
}
