export type Orientation = 'portrait' | 'landscape';
export type ViewState = 'empty' | 'loading' | 'loaded';

export const WINDOW_SIZE = {
  portrait: { width: 430, height: 900 },
  landscape: { width: 900, height: 450 },
} satisfies Record<Orientation, { width: number; height: number }>;

export const TIMING = {
  pageLoad: 20_000,
  webviewCreation: 10_000,
  stateRefresh: 1_200,
  rotation: 470,
} as const;
