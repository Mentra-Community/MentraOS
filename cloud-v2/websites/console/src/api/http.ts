import { z } from "zod";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function redirectToConsoleLogin(): void {
  if (typeof window === "undefined") return;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (window.location.pathname === "/") return;
  const search = new URLSearchParams();
  if (current && current !== "/") search.set("returnTo", current);
  const target = search.size > 0 ? `/?${search.toString()}` : "/";
  window.location.replace(target);
}

export async function apiRequest<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const body = await response.json() as { error_description?: string; error?: string };
      message = body.error_description || body.error || message;
    } catch {
      // Keep the generic status message when the response is not JSON.
    }
    throw new ApiError(message, response.status);
  }

  return schema.parse(await response.json());
}
