interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
}

// The page is leaving for the sign-in: the caller never gets an answer, so nothing flashes an error meanwhile.
const leaving = <T>(url: string) => {
  location.href = url;
  return new Promise<T>(() => {});
};

const here = () => encodeURIComponent(`${location.pathname}${location.hash}`);

// Calls the platform API with the session cookie. A failure is thrown with the server's own message.
export async function api<T>(path: string, { method = 'GET', body, form }: Options = {}): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const response = await fetch(path, init);
  if (response.status === 401) return leaving(`/login?returnTo=${here()}`);

  const data = response.status === 204 ? null : ((await response.json()) as { error?: string; reauth_required?: boolean } | null);
  // A decision needs a recent sign-in: back to the provider, then back here.
  if (data?.reauth_required) return leaving(`/auth/login?reauth=1&returnTo=${here()}`);
  if (!response.ok) throw new Error(data?.error ?? `Error ${response.status}`);
  return data as T;
}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
