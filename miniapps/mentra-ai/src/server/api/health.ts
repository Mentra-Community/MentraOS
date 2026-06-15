import type { Context } from "hono";

/** GET /health */
export function getHealth(c: Context) {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
}
