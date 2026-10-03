export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * Admin-API status codes have one likely cause each; bake the fix into the
 * error so it surfaces in the tool result instead of a bare status code.
 */
export function describeAdminApiStatus(status: number, what: string): string {
  switch (status) {
    case 401:
      return `unauthorized (401) fetching ${what} — MENTRA_ADMIN_TOKEN was rejected`;
    case 403:
      return `forbidden (403) fetching ${what} — token is valid but not admin-allowlisted (CLOUD_CORE_ADMIN_EMAILS)`;
    case 404:
      return `not found (404) fetching ${what} — wrong id, or this environment does not serve the admin reports API yet`;
    default:
      return `HTTP ${status} fetching ${what}`;
  }
}

export async function parseJsonResponse<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new ApiRequestError(
      `${describeAdminApiStatus(res.status, what)}${text ? `: ${text.slice(0, 500)}` : ""}`,
      res.status,
      text,
    );
  }
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiRequestError(`Invalid JSON response: ${text.slice(0, 200)}`, res.status, text);
  }
}
