/**
 * @fileoverview The Store's signed service API for a developer's own miniapp websites, mounted at
 * `/api/internal/website-clients` (`services/oidc/website-clients.service.ts`). The Developer Console
 * registers and changes them through it; Core never calls the Store.
 *
 * `serviceAuth` authenticates every route and each is the Store's (403 `forbidden` for any other service).
 * Bodies are at most 64 KiB (413 `payload_too_large`, `api/app.ts`).
 *
 * Every route carries `token`, the acting person's Core access token from Core's sign-in server. Core
 * verifies it itself: the Store's signature alone registers nothing, and the Store decides nothing about
 * who may register what. A person registers a website for a package only by redirecting to that package's
 * own domain, sees only the websites they registered, and changes only those.
 *
 * | Route                     | Takes                          | Answers                |
 * | ------------------------- | ------------------------------ | ---------------------- |
 * | `POST /list`              | `{token}`                      | `{clients, max}`       |
 * | `POST /create`            | `{token, client}`              | 201 `{client, secret}` |
 * | `POST /update`            | `{token, clientId, changes}`   | `{client}`             |
 * | `POST /regenerate-secret` | `{token, clientId}`            | `{client, secret}`     |
 * | `POST /delete`            | `{token, clientId}`            | `{deleted: true}`      |
 *
 * `client` is `{packageName, type, environment, redirectUris}`: the miniapp's package name, `browser` or
 * `server`, `production` or `development`, and exact redirect URIs. `changes` is any of `{redirectUris,
 * status}`. The website's name is the miniapp's own, from Core's registry; nobody types it.
 *
 * Failures: a token Core does not accept is 401 `invalid_token`; a key, or an account whose email is not
 * verified, is 403 `forbidden` with the `reason`; another person's client is 404 `not_found`; a package Core
 * has no registry entry for is 422 `not_in_registry`, an archived one 422 `archived`, a redirect URI off the
 * package's domain 422 `domain_mismatch`, and one website too many 422 `too_many_websites`; a malformed body
 * or client is 400 `invalid_request`. A secret is in the answer that creates it and nowhere else afterwards.
 */

import {INVALID_TOKEN_ERROR} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {
  deleteOwnWebsite,
  listWebsiteClients,
  MAX_WEBSITES_PER_DEVELOPER,
  regenerateOwnWebsiteSecret,
  registerOwnWebsite,
  updateOwnWebsite,
} from "../../services/oidc/website-clients.service"
import {principalFromToken} from "../../services/signin/principal.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {requireService, serviceAuth} from "../middleware/service-auth.middleware"
import {answeringRefusals} from "../website-clients.responses"
import {parseJsonObject, type JsonObject} from "../workspaces/request"

const app = new Hono<AppEnv>()

// Every route is the Store's. This also authenticates the request, so no route is open.
app.use("*", serviceAuth, requireService("store"))

const jsonBody = (c: AppContext): JsonObject => parseJsonObject(c.get("serviceBody") ?? "")
const isRecord = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

function requiredId(body: JsonObject, field: string): string {
  const value = body[field]
  if (typeof value !== "string" || !value.trim()) throw new InvalidRequest(`${field} must be a non-empty string`)
  return value.trim()
}

type Developer = {mentraUserId: string; label: string} | {response: Response}

/**
 * The person acting: a Core access token of a person whose email is verified. A key is refused: a website
 * is a person's to register, and theirs to answer for.
 */
async function developer(c: AppContext, body: JsonObject): Promise<Developer> {
  const token = body.token
  if (typeof token !== "string") throw new InvalidRequest("token must be a string")
  const principal = await principalFromToken(token)
  if (!principal) return {response: c.json({error: INVALID_TOKEN_ERROR}, 401)}
  if (principal.kind !== "user") {
    return {response: c.json({error: "forbidden", reason: "not_a_person", error_description: "a person registers a website, not a key"}, 403)}
  }
  if (!principal.emailVerified) {
    return {response: c.json({error: "forbidden", reason: "email_unverified", error_description: "verify your email address first"}, 403)}
  }
  return {mentraUserId: principal.mentraUserId, label: principal.email ?? principal.mentraUserId}
}

app.post("/list", async c => {
  const who = await developer(c, jsonBody(c))
  if ("response" in who) return who.response
  c.header("cache-control", "no-store")
  return c.json({clients: await listWebsiteClients({ownerUserId: who.mentraUserId}), max: MAX_WEBSITES_PER_DEVELOPER})
})

app.post("/create", c =>
  answeringRefusals(c, async () => {
    const body = jsonBody(c)
    const who = await developer(c, body)
    if ("response" in who) return who.response
    const client = body.client
    if (!isRecord(client)) throw new InvalidRequest("client must be an object")
    const created = await registerOwnWebsite(who, {
      packageName: client.packageName,
      type: client.type,
      environment: client.environment,
      redirectUris: client.redirectUris,
    })
    // The secret is shown once.
    c.header("cache-control", "no-store")
    return c.json(created, 201)
  }),
)

app.post("/update", c =>
  answeringRefusals(c, async () => {
    const body = jsonBody(c)
    const who = await developer(c, body)
    if ("response" in who) return who.response
    const changes = body.changes
    if (!isRecord(changes)) throw new InvalidRequest("changes must be an object")
    const client = await updateOwnWebsite(who, requiredId(body, "clientId"), {redirectUris: changes.redirectUris, status: changes.status})
    return c.json({client})
  }),
)

app.post("/regenerate-secret", c =>
  answeringRefusals(c, async () => {
    const body = jsonBody(c)
    const who = await developer(c, body)
    if ("response" in who) return who.response
    const regenerated = await regenerateOwnWebsiteSecret(who, requiredId(body, "clientId"))
    c.header("cache-control", "no-store")
    return c.json(regenerated)
  }),
)

app.post("/delete", c =>
  answeringRefusals(c, async () => {
    const body = jsonBody(c)
    const who = await developer(c, body)
    if ("response" in who) return who.response
    await deleteOwnWebsite(who, requiredId(body, "clientId"))
    return c.json({deleted: true})
  }),
)

export default app
