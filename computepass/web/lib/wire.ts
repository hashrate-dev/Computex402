export function encodeHeader(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeHeader<T>(value: string): T {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function jsonError(error: string, status: number, detail?: string) {
  return Response.json(
    { error, ...(detail ? { detail } : {}) },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Parses a JSON object body; returns null for anything else. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * POSTs JSON with a timeout. Throws on network error, timeout or a non-JSON
 * success body; a non-JSON error body yields `json: null`.
 */
export async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; json: T | null }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as T | null;
    return { ok: false, status: response.status, json };
  }
  const json = (await response.json()) as T;
  return { ok: response.ok, status: response.status, json };
}
