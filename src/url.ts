export function formatUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Enter a website URL first.');

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value)
    && !/^[^/?#]+:\d+(?:[/?#]|$)/.test(value);
  const host = value.split(/[/?#]/)[0];
  const local = /^(localhost(?:\.localhost)?|[^:]+\.localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\])(?::\d+)?$/i.test(host);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? value : `${local ? 'http' : 'https'}://${value}`);
  } catch {
    throw new Error('That does not look like a valid website URL.');
  }
  if (/[\s%]/.test(parsed.hostname)) {
    throw new Error('That does not look like a valid website URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Use an HTTP or HTTPS website URL.');
  }
  return parsed.href;
}
