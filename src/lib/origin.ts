// forms.allowed_origins holds exact origins ("https://acme.com"). Compared
// after normalizing through URL, so a trailing slash or letter case in the
// stored value doesn't lock a site out. No wildcards: a form is callable
// only from the origins listed on it.

function normalize(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]): origin is string {
  if (!origin) return false;
  const normalized = normalize(origin);
  if (!normalized) return false;
  return allowedOrigins.some((allowed) => normalize(allowed) === normalized);
}
