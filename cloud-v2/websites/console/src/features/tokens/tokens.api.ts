import { z } from "zod";
import { apiRequest } from "@/api/http";

export const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  obfuscatedValue: z.string().nullable(),
  value: z.string().nullable().optional(),
  permissions: z.array(z.string()),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});

export const apiTokensResponseSchema = z.object({
  tokens: z.array(apiTokenSchema),
});

export type ApiToken = z.infer<typeof apiTokenSchema>;

export function listApiTokens(): Promise<{ tokens: ApiToken[] }> {
  return apiRequest("/console/tokens", apiTokensResponseSchema);
}

export function createApiToken(input: { name: string }): Promise<{ token: ApiToken }> {
  return apiRequest("/console/tokens", z.object({ token: apiTokenSchema }), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteApiToken(tokenId: string): Promise<{ ok: boolean }> {
  return apiRequest("/console/tokens/" + encodeURIComponent(tokenId), z.object({ ok: z.boolean() }), {
    method: "DELETE",
  });
}
