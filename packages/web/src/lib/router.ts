import { useSyncExternalStore } from 'react';

// Pages live in the hash: every path outside it belongs to the server, and to the apps it serves.
const currentPath = () => location.hash.slice(1) || '/';

function subscribe(onChange: () => void) {
  addEventListener('hashchange', onChange);
  return () => removeEventListener('hashchange', onChange);
}

export const usePath = () => useSyncExternalStore(subscribe, currentPath);

export function navigate(path: string) {
  location.hash = `#${path}`;
}
