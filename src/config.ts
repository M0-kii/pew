export type Orientation = 'portrait' | 'landscape';
export type ViewState = 'empty' | 'opening' | 'loading' | 'ready' | 'rotating' | 'closing';

export const VIEWPORT_SIZE = {
  portrait: { width: 393, height: 852 },
  landscape: { width: 852, height: 393 },
} satisfies Record<Orientation, { width: number; height: number }>;

export const WINDOW_SIZE = {
  portrait: { width: 430, height: 900 },
  landscape: { width: 900, height: 450 },
} satisfies Record<Orientation, { width: number; height: number }>;

export const TIMING = {
  pageLoad: 20_000,
  webviewCreation: 10_000,
  stateRefresh: 1_200,
  rotation: 240,
} as const;
