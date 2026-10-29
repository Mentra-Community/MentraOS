import {createHash, timingSafeEqual} from "node:crypto";
import {createMiddleware} from "hono/factory";
import type {AppVariables} from "../../types/hono.types";

export interface TestHostEnv {Variables: AppVariables & {testHostId: string}}

/** Each controller credential identifies its host; request bodies cannot impersonate it. */
export function createTestHostAuth(credentials = () => process.env.TEST_HOST_TOKENS) {
  return createMiddleware<TestHostEnv>(async (c, next) => {
    let configured: unknown;
    try {configured = JSON.parse(credentials() ?? "null");} catch {configured = null;}
    if (!configured || typeof configured !== "object" || Array.isArray(configured))
      return c.json({error: "host_auth_unconfigured"}, 503);
    const entries = Object.entries(configured);
    if (!entries.length || entries.some(([host, token]) => !host || typeof token !== "string" || token.length < 32)
      || new Set(entries.map(([, token]) => token)).size !== entries.length)
      return c.json({error: "host_auth_unconfigured"}, 503);
    const supplied = /^Bearer (\S{1,4096})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!supplied) return c.json({error: "unauthorized"}, 401);
    const digest = (value: string) => createHash("sha256").update(value).digest();
    const suppliedHash = digest(supplied);
    const matched = entries.filter(([, token]) => timingSafeEqual(suppliedHash, digest(token as string)));
    if (matched.length !== 1) return c.json({error: "unauthorized"}, 401);
    c.set("testHostId", matched[0][0]);
    return next();
  });
}
