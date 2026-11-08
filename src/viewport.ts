export interface ViewportSettings {
  width: number;
  height: number;
  pixelRatio: number;
}

export const DEFAULT_VIEWPORT: ViewportSettings = { width: 393, height: 852, pixelRatio: 3 };
export const VIEWPORT_KEY = 'pew.viewport';
export const VIEWPORT_PRESETS = [
  { name: 'Compact phone', width: 360, height: 800, pixelRatio: 3 },
  { name: 'Phone', ...DEFAULT_VIEWPORT },
  { name: 'Large phone', width: 430, height: 932, pixelRatio: 3 },
  { name: 'Tablet', width: 768, height: 1024, pixelRatio: 2 },
];

export function validateViewport(
  width: number,
  height: number,
  pixelRatio: number,
): ViewportSettings {
  if (![width, height].every((value) => Number.isInteger(value) && value >= 240 && value <= 1920)) {
    throw new Error('Width and height must be whole numbers between 240 and 1920.');
  }
  if (![1, 2, 3].includes(pixelRatio)) throw new Error('Choose a pixel density of 1×, 2×, or 3×.');
  return { width, height, pixelRatio };
}

export function savedViewport(storage: Pick<Storage, 'getItem'>): ViewportSettings {
  try {
    const value = JSON.parse(storage.getItem(VIEWPORT_KEY) ?? 'null');
    return validateViewport(value.width, value.height, value.pixelRatio);
  } catch {
    return { ...DEFAULT_VIEWPORT };
  }
}
