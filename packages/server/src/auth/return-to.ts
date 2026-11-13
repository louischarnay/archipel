// Only accepts local paths, so as not to open an arbitrary redirect after login.
// The browser strips tabs and line breaks: only its own parser can be trusted.
const LOCAL_BASE = 'http://archipel.invalid';

export function safeReturnTo(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  try {
    const url = new URL(value, LOCAL_BASE);
    return url.origin === LOCAL_BASE ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}
