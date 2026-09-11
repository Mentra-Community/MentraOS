/**
 * @fileoverview The one REST helper every module uses.
 *
 * Centralizing REST here keeps behavior consistent across auth, runtime, and
 * core: one place builds the URL, attaches the Bearer header, parses JSON, maps
 * a non-2xx response to a typed `HttpError`, and retries only safe (idempotent)
 * calls on a transient failure. Modules never call `fetch` directly, so none of
 * them can drift on error handling or auth headers.
 *
 * Uses the global `fetch`, which exists on both a modern phone and a modern
 * server, so REST needs no platform input (unlike sockets and storage).
 *
 * See docs/issues/004-cloud-client/design.md ("The shared HTTP helper").
 */
import { HttpError } from "./errors";
import type { Logger } from "./logger";
import { systemTimers, type CloudClientTimers } from "./timers";
import type { HttpTransport } from "./transports";

/**
 * Per-request options.
 *
 * `bearer` overrides the default token source for this one call: the `/exchange`
 * call presents the subject token instead of an access token, and `/refresh`
 * presents the refresh token, so they pass `bearer` explicitly rather than going
 * through `cloud.auth`.
 *
 * `idempotent` marks a call as safe to retry on a transient network error. GET
 * is always treated as idempotent; the full-replace PUT opts in via this flag.
 * POST is never retried by default because it may not be safe to repeat.
 */
export interface ReqOpts {
  bearer?: string;
  idempotent?: boolean;
}

/** The REST surface the modules consume. */
export interface HttpClient {
  get<T>(path: string, opts?: ReqOpts): Promise<T>;
  head(path: string, opts?: ReqOpts): Promise<Response>;
  post<T>(path: string, body?: unknown, opts?: ReqOpts): Promise<T>;
  postForm<T>(path: string, form: FormData, opts?: ReqOpts): Promise<T>;
  put<T>(path: string, body: unknown, opts?: ReqOpts): Promise<T>;
  delete<T>(path: string, opts?: ReqOpts): Promise<T>;
  url(path: string): string;
}

/**
 * Dependencies for the helper.
 *
 * `getToken` is the default Bearer source (for example
 * `cloud.auth.getRuntimeToken` or `cloud.auth.getCoreToken`).
 * It is optional because the auth module's own `/exchange` and `/refresh` calls
 * run before any access token exists; those calls pass `opts.bearer` directly.
 */
export interface CreateHttpClientDeps {
  baseUrl: string;
  // default Bearer source, usually cloud.auth.getRuntimeToken/getCoreToken
  getToken?: () => Promise<string>;
  logger: Logger;
  fetch?: HttpTransport;
  timers?: CloudClientTimers;
}

/** How many times to retry a transient failure on an idempotent call. */
const MAX_RETRIES = 2;
/** Base backoff in milliseconds; doubles per attempt (250, 500, ...). */
const RETRY_BASE_MS = 250;

/**
 * Join a base URL and a path without producing a double slash or dropping one.
 *
 * Done by hand (not `new URL`) so a `baseUrl` that already carries a path prefix
 * (for example a proxy mount point) is preserved rather than discarded.
 */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

export function createHttpClient(deps: CreateHttpClientDeps): HttpClient {
  const { baseUrl, getToken, logger } = deps;
  const executeFetch = deps.fetch ?? globalThis.fetch;
  const timers = deps.timers ?? systemTimers;

  /**
   * Resolve the Bearer to attach: a per-call override wins, otherwise the
   * default token source. We never log the resolved token: tokens stay out of
   * logs everywhere in this library.
   */
  async function resolveBearer(opts?: ReqOpts): Promise<string | undefined> {
    if (opts?.bearer) return opts.bearer;
    if (getToken) return await getToken();
    return undefined;
  }

  /**
   * The one retry loop behind every request shape (JSON, form, bodyless).
   *
   * A network-level failure (DNS, reset, timeout) is transient and worth a
   * retry on an idempotent call. A non-2xx response is NOT transient here: it is
   * a definite answer from the server, mapped to an `HttpError` for the caller
   * to branch on (auth handles its own 401 refresh-and-retry a layer up).
   * The thrown exhaustion error keeps the network-error detail out of its
   * message to avoid leaking anything host-specific into a string a host might
   * surface to a user.
   */
  async function fetchWithRetry(args: {
    method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
    path: string;
    headers: Record<string, string>;
    body: string | FormData | undefined;
    idempotent: boolean;
  }): Promise<Response> {
    const { method, path, headers, body, idempotent } = args;
    const url = joinUrl(baseUrl, path);

    for (let attempt = 0; attempt <= (idempotent ? MAX_RETRIES : 0); attempt++) {
      if (attempt > 0) {
        const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
        logger.debug("http retrying request", { method, path, attempt });
        await new Promise<void>((resolve) => timers.setTimeout(resolve, backoff));
      }

      let res: Response;
      try {
        res = await executeFetch(url, { method, headers, body });
      } catch {
        // Transient network failure: let the loop retry.
        logger.warn("http network error", { method, path, attempt });
        continue;
      }

      if (!res.ok) {
        // Definite answer from the server: map to a typed error, no retry.
        throw await toHttpError(res, method, path);
      }

      return res;
    }

    // Exhausted retries on a transient failure.
    throw new HttpError(`Network request failed: ${method} ${path}`, 0, "NETWORK_ERROR");
  }

  async function requestRaw(
    method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD",
    path: string,
    body: unknown,
    opts?: ReqOpts,
  ): Promise<Response> {
    const bearer = await resolveBearer(opts);

    const headers: Record<string, string> = {};
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;

    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    // GET and DELETE are idempotent by HTTP semantics, so safe to retry; other
    // verbs opt in via the flag.
    const idempotent = opts?.idempotent ?? (method === "GET" || method === "DELETE" || method === "HEAD");

    return await fetchWithRetry({ method, path, headers, body: payload, idempotent });
  }

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    opts?: ReqOpts,
  ): Promise<T> {
    const res = await requestRaw(method, path, body, opts);
    return await parseJson<T>(res);
  }

  async function requestForm<T>(path: string, form: FormData, opts?: ReqOpts): Promise<T> {
    const bearer = await resolveBearer(opts);

    // No Content-Type here: fetch/FormData must generate the multipart
    // boundary. POST is not idempotent, so retries stay opt-in.
    const headers: Record<string, string> = {};
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;

    const res = await fetchWithRetry({
      method: "POST",
      path,
      headers,
      body: form,
      idempotent: opts?.idempotent ?? false,
    });
    return await parseJson<T>(res);
  }

  /**
   * Turn a non-2xx response into an `HttpError`, reading a machine-readable
   * `code` from the JSON body when the server provides one. We swallow any body
   * parse failure here because the status is the load-bearing signal and we do
   * not want a malformed error body to mask the real status.
   */
  async function toHttpError(res: Response, method: string, path: string): Promise<HttpError> {
    let code: string | undefined;
    let detail = "";
    try {
      const data = (await res.json()) as {
        code?: string;
        message?: string;
        error?: string;
        error_description?: string;
      };
      code = data?.code ?? data?.error;
      const message = data?.message ?? data?.error_description;
      detail = message ? `: ${message}` : "";
    } catch {
      // No JSON body, or unparseable: fall back to status alone.
    }
    return new HttpError(`HTTP ${res.status} on ${method} ${path}${detail}`, res.status, code);
  }

  /**
   * Parse a successful response as JSON, tolerating an empty body (a 204 or an
   * endpoint that returns nothing) by resolving to `undefined`.
   */
  async function parseJson<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    get<T>(path: string, opts?: ReqOpts): Promise<T> {
      return request<T>("GET", path, undefined, opts);
    },
    head(path: string, opts?: ReqOpts): Promise<Response> {
      return requestRaw("HEAD", path, undefined, opts);
    },
    post<T>(path: string, body?: unknown, opts?: ReqOpts): Promise<T> {
      return request<T>("POST", path, body, opts);
    },
    postForm<T>(path: string, form: FormData, opts?: ReqOpts): Promise<T> {
      return requestForm<T>(path, form, opts);
    },
    put<T>(path: string, body: unknown, opts?: ReqOpts): Promise<T> {
      return request<T>("PUT", path, body, opts);
    },
    delete<T>(path: string, opts?: ReqOpts): Promise<T> {
      return request<T>("DELETE", path, undefined, opts);
    },
    url(path: string): string {
      return joinUrl(baseUrl, path);
    },
  };
}
