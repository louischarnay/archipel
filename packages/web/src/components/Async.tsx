import type { ReactNode } from 'react';

interface Props<T> {
  state: { data: T | null; error: string | null };
  children: (data: T) => ReactNode;
}

// Renders a page once its data is there. A failed load shows the server's message instead.
export function Async<T>({ state, children }: Props<T>) {
  if (state.error) {
    return (
      <div className="page">
        <div className="banner red">{state.error}</div>
      </div>
    );
  }
  return state.data === null ? null : children(state.data);
}
