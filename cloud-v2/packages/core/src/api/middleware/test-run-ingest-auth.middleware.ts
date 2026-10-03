import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../../types/hono.types";

/** Worker-only capability. It grants ingestion/upload, never admin browsing or other APIs. */
export const testRunIngestAuth = createMiddleware<AppEnv>(async (c, next) => {
  const expected = process.env.TEST_RUN_INGEST_TOKEN;
  if (!expected || expected.length < 32) {
    return c.json({ error: "unavailable", error_description: "test run ingestion is not configured" }, 503);
  }
  const provided = /^Bearer (\S{1,4096})$/.exec(c.req.header("authorization") ?? "")?.[1];
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    return c.json({ error: "unauthorized", error_description: "test run ingestion token required" }, 401);
  }
  return next();
});
