const API_BASE = (import.meta.env.VITE_XTCTX_API_BASE as string | undefined) ?? "http://127.0.0.1:3232";

export async function apiGet<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(path, API_BASE);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, API_BASE);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
}

export function getApiBase(): string {
  return API_BASE;
}
