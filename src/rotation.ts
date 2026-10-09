import { LogicalSize } from '@tauri-apps/api/dpi';
import type { Window } from '@tauri-apps/api/window';
import { WINDOW_SIZE, type Orientation } from './config';

export async function animateWindowSize(
  appWindow: Window | null,
  from: Orientation,
  to: Orientation,
  duration: number,
): Promise<void> {
  if (!appWindow) return;
  const start = WINDOW_SIZE[from];
  const end = WINDOW_SIZE[to];
  const startedAt = performance.now();

  while (true) {
    const progress = Math.min(1, (performance.now() - startedAt) / duration);
    const eased = progress * progress * (3 - 2 * progress);
    const width = Math.round(start.width + (end.width - start.width) * eased);
    const height = Math.round(start.height + (end.height - start.height) * eased);
    await appWindow.setSize(new LogicalSize(width, height));
    await appWindow.center();
    if (progress >= 1) break;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
