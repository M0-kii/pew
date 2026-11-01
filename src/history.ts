import { formatUrl } from './url.ts';

export const HISTORY_KEY = 'pew.recent-urls';

export function recentUrls(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const values: unknown = JSON.parse(storage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(values)) return [];
    return [
      ...new Set(
        values
          .filter((value): value is string => typeof value === 'string')
          .map(historyUrl)
          .filter((value): value is string => value !== null),
      ),
    ].slice(0, 5);
  } catch {
    return [];
  }
}

function historyUrl(value: string): string | null {
  try {
    const url = new URL(formatUrl(value));
    if (url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function rememberUrl(storage: Pick<Storage, 'getItem' | 'setItem'>, value: string): void {
  const url = historyUrl(value);
  if (!url) return;
  try {
    storage.setItem(
      HISTORY_KEY,
      JSON.stringify([url, ...recentUrls(storage).filter((item) => item !== url)].slice(0, 5)),
    );
  } catch {
    // Previewing still works when local storage is unavailable.
  }
}
