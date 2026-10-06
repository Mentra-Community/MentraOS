export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The server's machine-readable `error` code, when the body had one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: opts?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(opts?.body ? { "content-type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: unknown; error_description?: string; message?: string };
      detail = body.error_description ?? body.message ?? detail;
      if (typeof body.error === "string") code = body.error;
    } catch {
      // Keep the status detail when the response is not JSON.
    }
    throw new ApiError(detail, res.status, code);
  }
  // A DELETE answers 204 with no body to parse.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
