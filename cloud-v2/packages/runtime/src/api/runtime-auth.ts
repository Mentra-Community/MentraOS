import type { Context } from "hono";
import {
  AccessTokenError,
  verifyRuntimeToken,
  type VerifiedAccessToken,
} from "@mentra/cloud-shared";

export async function authenticateRuntimeRequest(
  c: Context,
): Promise<{ identity: VerifiedAccessToken } | { error: Response }> {
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : undefined;
  if (!token) {
    return {
      error: c.json({ error: "missing or malformed Authorization" }, 401),
    };
  }
  try {
    return { identity: await verifyRuntimeToken(token) };
  } catch (err) {
    if (err instanceof AccessTokenError) {
      return { error: c.json({ error: err.message }, 401) };
    }
    throw err;
  }
}
