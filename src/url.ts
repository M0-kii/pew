function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]') {
    return true;
  }

  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    !octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  ) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 127 ||
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31)
  );
}

export function formatUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Enter a website URL first.');

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/?#]+:\d+(?:[/?#]|$)/.test(value);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    throw new Error('That does not look like a valid website URL.');
  }
  if (/[\s%]/.test(parsed.hostname)) {
    throw new Error('That does not look like a valid website URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Use an HTTP or HTTPS website URL.');
  }
  if (!hasScheme && isLocalHost(parsed.hostname)) return new URL(`http://${value}`).href;
  return parsed.href;
}
