import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList } from 'react';
import { messageOf } from '../api/client';

interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => Promise<void>;
}

interface Result<T> {
  key: string;
  data: T | null;
  error: string | null;
}

// Loads what a page shows, again whenever `deps` change. `reload` refreshes it in place after an action.
// `deps` are plain values (ids, tab names, counters): they identify what is shown.
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const key = JSON.stringify(deps);
  const [result, setResult] = useState<Result<T> | null>(null);
  // Only the latest request may answer: a slow one must not overwrite the page that replaced it.
  const latest = useRef(0);
  // The caller's function changes on every render; the latest one is the one to call.
  const current = useRef(load);
  useLayoutEffect(() => {
    current.current = load;
  });

  const reload = useCallback(async () => {
    const request = ++latest.current;
    try {
      const data = await current.current();
      if (request === latest.current) setResult({ key, data, error: null });
    } catch (error) {
      if (request === latest.current) setResult({ key, data: null, error: messageOf(error) });
    }
  }, [key]);

  useEffect(() => {
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [reload]);

  // Until the new answer arrives, what was loaded for other values is not shown.
  const shown = result?.key === key ? result : null;
  return { data: shown?.data ?? null, error: shown?.error ?? null, reload };
}
