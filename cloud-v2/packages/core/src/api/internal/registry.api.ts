/**
 * @fileoverview The miniapp registry's signed service API, mounted at `/api/internal/registry`
 * (`services/registry/registry-service-api.service.ts`). Fleet checks and names miniapps; the directory reads and
 * archives entries. `serviceAuth` authenticates every route (401 `service_unauthorized` without a valid signature),
 * and each route is one service's: any other is 403 `forbidden`. Bodies are at most 64 KiB (413
 * `payload_too_large`, `api/app.ts`). A body that isn't what a route takes is 400 `invalid_request`.
 *
 * | Route                    | Service | Takes                                                 | Answers                                  |
 * | ------------------------ | ------- | ----------------------------------------------------- | ---------------------------------------- |
 * | `POST /check`            | fleet   | `{urls: [1..50], workspaceId, mentraUserId}`          | `{results}`; 403 `not_a_member`          |
 * | `POST /lookup`           | fleet   | `{workspaceId, packageNames: [1..500]}`               | `{entries}`                              |
 * | `GET /entries?url=`      | store   |                                                       | `{entry}`; 404 `not_found`               |
 * | `POST /archive`          | store   | `{rule: {kind, value}, reason, actorEmail}`           | `{rule, created, entriesArchived}`       |
 *
 * The shapes are `@mentra/workspace-contract`'s (`RegistryCheckResult`, `RegistryLookupEntry`,
 * `RegistryEntryDetail`, `RegistryArchiveResponse`), spoken by its `createCoreWorkspaceClient`.
 */

import {
  NOT_A_MEMBER_ERROR,
  REGISTRY_CHECK_MAX_URLS,
  REGISTRY_ENTRY_NOT_FOUND_ERROR,
  REGISTRY_LOOKUP_MAX_PACKAGES,
  type RegistryArchiveResponse,
  type RegistryCheckResponse,
  type RegistryEntryResponse,
  type RegistryLookupResponse,
} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {z} from "zod"
import {MINIAPP_REGISTRY_ARCHIVE_RULE_KINDS} from "../../models/miniapp-registry.model"
import {RegistryRequestError} from "../../services/registry/registry.service"
import {
  archiveForDirectory,
  checkRegistryUrls,
  lookupRegistryPackages,
  RegistryCheckRefused,
  registryEntryForDirectory,
} from "../../services/registry/registry-service-api.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {requireService, serviceAuth} from "../middleware/service-auth.middleware"
import {parseJsonObject} from "../workspaces/request"

const MAX_URL_LENGTH = 2048
const MAX_ID_LENGTH = 128
const MAX_PACKAGE_NAME_LENGTH = 256
const MAX_REASON_LENGTH = 1000
const MAX_EMAIL_LENGTH = 320

const Id = z.string().trim().min(1).max(MAX_ID_LENGTH)

const CheckRequestSchema = z.object({
  urls: z.array(z.string().min(1).max(MAX_URL_LENGTH)).min(1).max(REGISTRY_CHECK_MAX_URLS),
  workspaceId: Id,
  mentraUserId: Id,
})

const LookupRequestSchema = z.object({
  workspaceId: Id,
  packageNames: z.array(z.string().min(1).max(MAX_PACKAGE_NAME_LENGTH)).min(1).max(REGISTRY_LOOKUP_MAX_PACKAGES),
})

const ArchiveRequestSchema = z.object({
  rule: z.object({kind: z.enum(MINIAPP_REGISTRY_ARCHIVE_RULE_KINDS), value: z.string().min(1).max(MAX_URL_LENGTH)}),
  reason: z.string().max(MAX_REASON_LENGTH),
  actorEmail: z
    .string()
    .trim()
    .max(MAX_EMAIL_LENGTH)
    .regex(/^[^\s@]+@[^\s@]+$/, "must be an email address"),
})

/** The signed body, parsed with `schema`; anything else is a 400 that says what the route takes. */
function signedBody<T extends z.ZodTypeAny>(c: AppContext, schema: T, takes: string): z.infer<T> {
  const parsed = schema.safeParse(parseJsonObject(c.get("serviceBody") ?? ""))
  if (!parsed.success) throw new InvalidRequest(`body must be ${takes}`)
  return parsed.data
}

const app = new Hono<AppEnv>()

// Every route is a service's. This also authenticates the request, so no route is open.
app.use("*", serviceAuth)

app.post("/check", requireService("fleet"), async (c) => {
  const body = signedBody(
    c,
    CheckRequestSchema,
    `{urls: [1..${REGISTRY_CHECK_MAX_URLS} miniapp URLs], workspaceId, mentraUserId}`,
  )
  try {
    const answer: RegistryCheckResponse = {results: await checkRegistryUrls(body)}
    return c.json(answer)
  } catch (error) {
    if (error instanceof RegistryCheckRefused) {
      return c.json(
        {error: NOT_A_MEMBER_ERROR, error_description: "workspaceId is not an active workspace, or mentraUserId is not a live account"},
        403,
      )
    }
    throw error
  }
})

app.post("/lookup", requireService("fleet"), async (c) => {
  const body = signedBody(c, LookupRequestSchema, `{workspaceId, packageNames: [1..${REGISTRY_LOOKUP_MAX_PACKAGES}]}`)
  const answer: RegistryLookupResponse = {entries: await lookupRegistryPackages(body)}
  return c.json(answer)
})

app.get("/entries", requireService("store"), async (c) => {
  const url = c.req.query("url")
  if (!url || url.length > MAX_URL_LENGTH) throw new InvalidRequest("url must be a miniapp URL")
  const entry = await registryEntryForDirectory(url)
  if (!entry)
    return c.json({error: REGISTRY_ENTRY_NOT_FOUND_ERROR, error_description: "no registry entry for this URL"}, 404)
  const answer: RegistryEntryResponse = {entry}
  return c.json(answer)
})

app.post("/archive", requireService("store"), async (c) => {
  const body = signedBody(
    c,
    ArchiveRequestSchema,
    "{rule: {kind: url | package | domain | account, value}, reason, actorEmail}",
  )
  try {
    const answer: RegistryArchiveResponse = await archiveForDirectory(body)
    return c.json(answer)
  } catch (error) {
    if (error instanceof RegistryRequestError) throw new InvalidRequest(error.message)
    throw error
  }
})

export default app
