// Preferences kept in the browser. Without storage, they last as long as the page.
export function recall(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function remember(key: string, value: string | number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage refused: nothing else depends on it.
  }
}
