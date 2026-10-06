/**
 * @fileoverview Service authentication for Core's internal workspace API.
 *
 * The Store and the Fleet integration call `/api/internal/workspaces/*` with an
 * HMAC signature (`@mentra/workspace-contract`, `signServiceRequest`) over the
 * timestamp, method, path with query and body. `serviceAuth` verifies it and
 * sets `c.var.service` to the service that signed (`store` or `fleet`);
 * `requireService` then limits a route to some of them.
 *
 * Secrets come from `CLOUD_CORE_SERVICE_SECRETS`, a JSON object that maps each
 * service to a list of secrets, newest first, so a secret can be rotated by
 * listing the old one beside the new one:
 *
 *     {"store": ["s1", "s0"], "fleet": ["f1"]}
 *
 * Status mapping:
 *  - the variable is not valid JSON of that shape: 503
 *    `{error: "service_auth_misconfigured"}` for every call. Core cannot tell
 *    who is allowed in, so it lets nobody in, and says why;
 *  - a missing header, a service Core has no secret for (including no
 *    configuration at all), a signature that matches none of the service's
 *    secrets, or a timestamp more than 60 seconds off: 401
 *    `{error: "service_unauthorized"}`. One answer for all of them, so a caller
 *    learns nothing about which services or secrets exist;
 *  - a service that is authenticated but not allowed on a route: 403
 *    `{error: "forbidden"}`.
 *
 * The signature covers the body, so the body is read here, once, as text
 * (stashed on `c.var.serviceBody` for handlers to parse) and nothing is parsed
 * before the signature verifies. The path is signed exactly as received.
 */

import {createLogger} from "@mentra/cloud-shared"
import {SERVICE_UNAUTHORIZED_ERROR} from "@mentra/workspace-contract"
import {SERVICE_HEADERS, verifyServiceRequest} from "@mentra/workspace-contract/server"
import type {MiddlewareHandler} from "hono"
import {createMiddleware} from "hono/factory"
import type {AppContext, AppEnv, AppVariables} from "../../types/hono.types"

const logger = createLogger("core").child({service: "service-auth"})

export type ServiceName = NonNullable<AppVariables["service"]>

/** The services Core has a role for. A name outside this list can never authenticate. */
export const SERVICE_NAMES: readonly ServiceName[] = ["store", "fleet"]

/** A timestamp header is a plain count of milliseconds: digits only, so one value has one spelling. */
const TIMESTAMP_PATTERN = /^\d{1,15}$/

type ServiceSecrets = ReadonlyMap<ServiceName, readonly string[]>

// The configuration is read on every request, so a changed value takes effect at once; parsing is
// cached by the raw string so a bad value is logged once rather than on every call.
let parsed: {raw: string; secrets: ServiceSecrets | null} | undefined

/** The configured secrets by service, or null when `CLOUD_CORE_SERVICE_SECRETS` is malformed. */
function configuredSecrets(): ServiceSecrets | null {
  const raw = process.env.CLOUD_CORE_SERVICE_SECRETS ?? ""
  if (parsed?.raw !== raw) parsed = {raw, secrets: parseSecrets(raw)}
  return parsed.secrets
}

function parseSecrets(raw: string): ServiceSecrets | null {
  // No configuration is a valid, empty one: this deployment has no services, so nobody authenticates.
  if (!raw.trim()) return new Map()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    logger.error("CLOUD_CORE_SERVICE_SECRETS is not valid JSON; refusing every internal service call")
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    logger.error("CLOUD_CORE_SERVICE_SECRETS must be a JSON object of service name to a list of secrets")
    return null
  }
  const secrets = new Map<ServiceName, readonly string[]>()
  for (const [name, list] of Object.entries(value)) {
    if (!Array.isArray(list) || list.length === 0 || list.some(secret => typeof secret !== "string")) {
      logger.error({service: name}, "CLOUD_CORE_SERVICE_SECRETS must list at least one secret string per service")
      return null
    }
    const known = SERVICE_NAMES.find(service => service === name)
    if (known) secrets.set(known, list as string[])
    else logger.warn({service: name}, "CLOUD_CORE_SERVICE_SECRETS names a service Core does not know; ignoring it")
  }
  return secrets
}

const unauthorized = (c: AppContext) => c.json({error: SERVICE_UNAUTHORIZED_ERROR}, 401)

/**
 * Requires a signed request from a service Core has a secret for. On success `c.var.service` names it
 * and `c.var.serviceBody` is the raw body the signature covered.
 */
export const serviceAuth: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const secrets = configuredSecrets()
  if (!secrets) return c.json({error: "service_auth_misconfigured"}, 503)

  const claimed = c.req.header(SERVICE_HEADERS.service)
  const timestamp = c.req.header(SERVICE_HEADERS.timestamp)
  const signature = c.req.header(SERVICE_HEADERS.signature)
  if (!claimed || !timestamp || !signature || !TIMESTAMP_PATTERN.test(timestamp)) return unauthorized(c)
  // A lookup by a name from the request must only ever match the services above, never an inherited key.
  const service = SERVICE_NAMES.find(name => name === claimed)
  const serviceSecrets = service ? secrets.get(service) : undefined
  if (!service || !serviceSecrets) return unauthorized(c)

  const url = new URL(c.req.url)
  const body = await c.req.text()
  const verified = verifyServiceRequest({
    secrets: serviceSecrets,
    method: c.req.method,
    pathWithQuery: url.pathname + url.search,
    body,
    timestampMs: Number(timestamp),
    signature,
    nowMs: Date.now(),
  })
  if (!verified) return unauthorized(c)

  c.set("service", service)
  c.set("serviceBody", body)
  return next()
})

/**
 * Limits a route to the named services. A request that did not go through `serviceAuth` has no
 * service and is refused as unauthenticated, so mounting a route without it fails closed.
 */
export function requireService(...allowed: ServiceName[]): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const service = c.get("service")
    if (!service) return unauthorized(c)
    if (!allowed.includes(service)) return c.json({error: "forbidden"}, 403)
    return next()
  })
}
