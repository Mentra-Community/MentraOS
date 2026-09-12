import * as jose from "jose"
import {createMentraAuth} from "@mentra/auth"
import {createMiddleware} from "hono/factory"
import type {AppEnv} from "../../types/hono.types"

const MINIAPP_TOKEN_KID = "mentra-miniapp-1"
const DEFAULT_STORE_PACKAGE = "com.mentra.store"

/**
 * Authenticate the Store miniapp, the only client of these routes.
 *
 * Exactly one credential is accepted: a miniapp token minted for a configured
 * Store package, verified through the public Core JWKS contract. Core access
 * tokens are deliberately refused — a service that honours another service's
 * audience turns a leak anywhere into a leak everywhere, and that coupling is
 * why the phone host once had to be told the Store's address at all.
 */
export const storeUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  try {
    const token = bearerToken(c.req.header("authorization"))
    if (jose.decodeProtectedHeader(token).kid !== MINIAPP_TOKEN_KID) {
      throw new Error("not a Store miniapp token")
    }
    const verified = await verifyStoreMiniappToken(token)
    c.set("user", {
      mentraUserId: verified.mentraUserId,
      tenantId: verified.tenantId ?? "mentra",
      sessionId: verified.tokenId ?? "store-miniapp",
    })
  } catch {
    return c.json({error: "unauthorized", error_description: "Store credential rejected"}, 401)
  }
  return next()
})

export const optionalStoreUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.req.header("authorization")) return next()
  return storeUserAuth(c, next)
})

async function verifyStoreMiniappToken(token: string) {
  let lastError: unknown
  for (const packageName of configuredStorePackages()) {
    try {
      return await createMentraAuth({
        packageName,
        ...(configuredJwksUrls().length ? {jwksUrls: configuredJwksUrls()} : {}),
      }).verifyToken(token)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error("no trusted Store package configured")
}

function configuredStorePackages(): string[] {
  const configured = process.env.CLOUD_STORE_MINIAPP_PACKAGE_NAMES?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return configured?.length ? configured : [DEFAULT_STORE_PACKAGE]
}

function configuredJwksUrls(): string[] {
  const list = process.env.MENTRA_STORE_CORE_JWKS_URLS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  if (list?.length) return list
  const one = process.env.MENTRA_STORE_CORE_JWKS_URL?.trim()
  return one ? [one] : []
}

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) throw new Error("missing bearer token")
  const token = header.slice(7).trim()
  if (!token) throw new Error("empty bearer token")
  return token
}
