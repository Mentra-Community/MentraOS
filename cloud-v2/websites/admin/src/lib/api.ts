export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The response body's `error` code, when it sent one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts?: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  const timeout = opts?.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs);
  const signal = timeout && opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout ?? opts?.signal;
  try {
    const res = await fetch(path, {
      method: opts?.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(opts?.body ? { "content-type": "application/json" } : {}),
      },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: string; error_description?: string; message?: string };
        detail = body.error_description ?? body.message ?? detail;
        code = typeof body.error === "string" ? body.error : undefined;
      } catch {
        // Keep the status detail when the response is not JSON.
      }
      throw new ApiError(detail, res.status, code);
    }
    // A 204 (a revocation, say) has no body.
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  } catch (error) {
    if (timeout?.aborted && timeout.reason?.name === "TimeoutError") {
      throw new Error("Request timed out. Please try again.");
    }
    throw error;
  }
}
