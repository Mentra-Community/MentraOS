/**
 * @fileoverview What the routes that run inside Core's sign-in server share (`interaction.api.ts`,
 * `connections.api.ts`): they are Koa middleware on the provider, not Hono routes, because they need the
 * provider's cookies and Node's request and response.
 */

import type {IncomingMessage} from "node:http"

import type Provider from "oidc-provider"

import {consumeRateLimit} from "../../services/signin/rate-limit.service"

const MAX_BODY_BYTES = 16 * 1024

export type KoaContext = Parameters<Parameters<Provider["use"]>[0]>[0]

export function json(ctx: KoaContext, status: number, body: unknown): void {
  ctx.status = status
  ctx.set("cache-control", "no-store")
  ctx.type = "application/json"
  ctx.body = JSON.stringify(body)
}

export function redirect(ctx: KoaContext, location: string): void {
  ctx.status = 303
  ctx.set("cache-control", "no-store")
  ctx.set("location", location)
}

/** The caller's IP for rate limits: the first `x-forwarded-for` hop (the ingress sets it). */
export function clientIp(ctx: KoaContext): string {
  return ctx.get("x-forwarded-for").split(",")[0]?.trim() || "unknown"
}

/** CSRF: `Origin` must be the issuer's origin, or, without one, `Sec-Fetch-Site: same-origin`. */
export function isSameOrigin(ctx: KoaContext, issuer: string): boolean {
  const origin = ctx.get("origin")
  if (origin) return origin === new URL(issuer).origin
  return ctx.get("sec-fetch-site") === "same-origin"
}

/** The request's JSON object, or null when it is not one or is too large. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const isJson = (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  // Drain the whole body even past the limit, so the connection stays usable.
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) tooLarge = true
    else chunks.push(chunk as Buffer)
  }
  if (tooLarge || !isJson) return null
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** One call against a per-minute limit; false once it is spent. */
export async function withinLimit(key: string, limit: number): Promise<boolean> {
  return consumeRateLimit(key, limit, 60)
}
