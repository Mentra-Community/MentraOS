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
