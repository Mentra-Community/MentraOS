import {createHmac, timingSafeEqual} from "node:crypto"
import {createMiddleware} from "hono/factory"
import type {AppEnv} from "../../types/hono.types"

export const storeServiceAuth = createMiddleware<AppEnv>(async (c, next) => {
  const timestamp = c.req.header("x-mentra-service-timestamp")
  const supplied = c.req.header("x-mentra-service-signature")
  const principal = c.req.header("x-mentra-admin-principal")?.trim()
  const secret = (process.env.MENTRA_SERVICE_AUTH_SECRET ?? process.env.WORKOS_API_KEY)?.trim()
  const time = Number(timestamp)
  if (
    !secret ||
    !timestamp ||
    !supplied ||
    !principal ||
    !Number.isFinite(time) ||
    Math.abs(Date.now() - time) > 60_000
  ) {
    return c.json({error: "unauthorized"}, 401)
  }
  const target = new URL(c.req.url)
  const path = `${target.pathname}${target.search}`
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}\n${c.req.method}\n${path}\n${principal}`)
    .digest("base64url")
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return c.json({error: "unauthorized"}, 401)
  c.set("developer", {developerId: principal, email: principal})
  c.set("isAdmin", true)
  return next()
})
