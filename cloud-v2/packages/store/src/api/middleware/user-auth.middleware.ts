import {verifyAccessTokenSignature} from "@mentra/cloud-shared"
import {createMiddleware} from "hono/factory"
import type {AppEnv} from "../../types/hono.types"

export const userAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization")
  if (!header?.startsWith("Bearer ")) return c.json({error: "unauthorized"}, 401)
  const token = header.slice(7).trim()
  if (!token) return c.json({error: "unauthorized"}, 401)
  try {
    const verified = await verifyAccessTokenSignature(token)
    c.set("user", {
      mentraUserId: verified.mentraUserId,
      tenantId: verified.tenantId,
      sessionId: verified.sessionId,
    })
  } catch {
    return c.json({error: "unauthorized"}, 401)
  }
  return next()
})

export const optionalUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.req.header("authorization")) return next()
  return userAuth(c, next)
})
