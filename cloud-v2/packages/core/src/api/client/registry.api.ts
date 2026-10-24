/**
 * @fileoverview `/api/client/registry`: the Mentra App's registry calls (`services/registry/registry.service.ts`).
 *
 *   POST /register  {url, reported?: {packageName, name, version, ageRating?}}
 *                   at each install. Core verifies the URL with its own fetcher, then answers
 *                   `{result: "accepted", entry, manifest}`, `{result: "accepted_unverified", entry}`,
 *                   `{result: "not_a_miniapp", reason}` or `{result: "archived"}`.
 *   POST /status    {entries: [{url, version}]}, at most 500
 *                   `{statuses: [{url, status: "active" | "archived" | "unknown"}], validForSeconds}`
 *
 * The gate is the phone's Core access token (`userAuth`); missing, invalid or deleted is 401, as on the phone's
 * workspace routes, so the phone refreshes its session. An answer Core can give without reading the URL (an archived
 * URL, or one that can't be a miniapp) goes to any signed-in phone, so archiving holds everywhere. Reading the URL
 * needs a verified account (`accountIsVerified`: a Mentra account with a verified email, or a person signed in through
 * this Core's own identity provider): otherwise `403 email_unverified`, or `503 unavailable` when the account
 * directory can't say. Each account registers at most 120 URLs an hour (`429 rate_limited` with `Retry-After`).
 *
 * The status call answers any signed-in phone, so archiving stops updates for everyone; only a verified account makes
 * Core read URLs again from it. A malformed body is `400 invalid_request`.
 */

import {
  MINIAPP_REGISTRY_STATUS_MAX_ENTRIES,
  RegistryRegisterRequestSchema,
  RegistryStatusRequestSchema,
  type RegistryRegisterResponse,
} from "@mentra/cloud-protocol"
import {Hono} from "hono"
import type {MiddlewareHandler} from "hono"
import {bodyLimit} from "hono/body-limit"
import type {z} from "zod"
import {accountIsVerified} from "../../services/account/verified-account.service"
import {
  answerWithoutReading,
  consumeRegistration,
  registerMiniappUrl,
  registryStatus,
  RegistryRequestError,
  type RegisterMiniappUrlResult,
} from "../../services/registry/registry.service"
import {isDeletedAccountId} from "../../services/user.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidGrant, InvalidRequest} from "../../types/oauth.types"
import {userAuth} from "../middleware/user-auth.middleware"

/** A registration is a URL and a short report. */
const REGISTER_BODY_LIMIT_BYTES = 16 * 1024
/** 500 entries, each a URL of up to 2,048 characters and a version. */
const STATUS_BODY_LIMIT_BYTES = 2 * 1024 * 1024

const app = new Hono<AppEnv>()

const unauthorized = (c: AppContext) => c.json({error: "unauthorized", error_description: "sign-in required"}, 401)
const invalidRequest = (c: AppContext, description: string) =>
  c.json({error: "invalid_request", error_description: description}, 400)

/** The phone's Core access token, of an account that isn't deleted. Anything else is 401. */
const phoneAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await userAuth(c, async () => {})
  } catch (err) {
    if (err instanceof InvalidRequest || err instanceof InvalidGrant) return unauthorized(c)
    throw err
  }
  const user = c.var.user
  if (!user || (await isDeletedAccountId(user.mentraUserId))) return unauthorized(c)
  return next()
}

const limitBody = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({error: "payload_too_large", error_description: "request body too large"}, 413),
  })

/** The JSON body parsed with `schema`, or null when it isn't one. */
async function readBody<T extends z.ZodTypeAny>(c: AppContext, schema: T): Promise<z.infer<T> | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await c.req.text())
  } catch {
    return null
  }
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The answer on the wire: the result without the service's own notes. */
function toResponse(result: RegisterMiniappUrlResult): RegistryRegisterResponse {
  if (result.result === "not_a_miniapp") return {result: "not_a_miniapp", reason: result.reason}
  return result
}

app.use("*", phoneAuth)

app.post("/register", limitBody(REGISTER_BODY_LIMIT_BYTES), async (c) => {
  const user = c.var.user!
  const body = await readBody(c, RegistryRegisterRequestSchema)
  if (!body) return invalidRequest(c, "body must be {url, reported?: {packageName, name, version, ageRating?}}")
  const registrant = {mentraUserId: user.mentraUserId, tenantId: user.tenantId}

  // Archived, or not a miniapp URL at all: answered for every signed-in phone, before the gates on reading a URL.
  let early: RegisterMiniappUrlResult | null
  try {
    early = await answerWithoutReading({url: body.url, reportedPackageName: body.reported?.packageName, registrant})
  } catch (error) {
    if (error instanceof RegistryRequestError) return invalidRequest(c, error.message)
    throw error
  }
  if (early) {
    c.header("cache-control", "no-store")
    return c.json(toResponse(early))
  }

  let verified: boolean
  try {
    verified = await accountIsVerified(registrant)
  } catch {
    return c.json({error: "unavailable", error_description: "could not confirm your email; try again"}, 503)
  }
  if (!verified) {
    return c.json({error: "email_unverified", error_description: "registering a miniapp needs a verified email"}, 403)
  }

  const retryAfter = await consumeRegistration(user.mentraUserId)
  if (retryAfter !== null) {
    c.header("retry-after", String(retryAfter))
    return c.json({error: "rate_limited", error_description: "too many miniapps registered in the last hour"}, 429)
  }

  let result: RegisterMiniappUrlResult
  try {
    result = await registerMiniappUrl({url: body.url, reported: body.reported, registrant})
  } catch (error) {
    if (error instanceof RegistryRequestError) return invalidRequest(c, error.message)
    throw error
  }
  c.header("cache-control", "no-store")
  return c.json(toResponse(result))
})

app.post("/status", limitBody(STATUS_BODY_LIMIT_BYTES), async (c) => {
  const user = c.var.user!
  const body = await readBody(c, RegistryStatusRequestSchema)
  if (!body) {
    return invalidRequest(c, `body must be {entries: [{url, version}]} with at most ${MINIAPP_REGISTRY_STATUS_MAX_ENTRIES} entries`)
  }
  // Only a verified account makes Core read URLs; the answer itself is everyone's.
  const caller = {mentraUserId: user.mentraUserId, tenantId: user.tenantId}
  const answer = await registryStatus({
    entries: body.entries,
    caller,
    reverify: await accountIsVerified(caller).catch(() => false),
  })
  c.header("cache-control", "no-store")
  return c.json(answer)
})

export default app
