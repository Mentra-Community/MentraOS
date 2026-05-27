import { z } from "zod";

export function textContent(data: unknown, isError = false) {
  const text =
    typeof data === "string"
      ? data
      : (JSON.stringify(data, null, 2) ?? String(data));
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

export function unwrapData<T>(response: { data?: T; success?: boolean } | T): T {
  if (response && typeof response === "object" && "data" in response) {
    return (response as { data: T }).data;
  }
  return response as T;
}

export const confirmSchema = z
  .boolean()
  .optional()
  .describe("Must be true for destructive operations");

export function requireConfirm(confirm: boolean | undefined, operation: string): void {
  if (confirm !== true) {
    throw new Error(`${operation} requires confirm: true`);
  }
}

/** Fields allowed on app create per console.apps.service.ts */
export const APP_CREATE_FIELDS = [
  "packageName",
  "name",
  "description",
  "publicUrl",
  "appType",
  "tools",
  "permissions",
  "settings",
  "hardwareRequirements",
  "onboardingInstructions",
  "orgId",
] as const;
