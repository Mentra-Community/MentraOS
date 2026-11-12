/**
 * @fileoverview The admin portal's miniapp registry (`/api/admin/registry`, `docs/registry.md`), mounted by
 * `admin.api.ts` behind `organization.registry.administer`, which only an Organization Admin holds: no operator key
 * carries it.
 *
 *   GET  /entries?q=&status=&verification=&cursor=   every entry, newest first, 50 to a page
 *   GET  /export                                    every entry as CSV, for App Review
 *   POST /register   {urls}                         registers 1 to 50 URLs as the Organization Admin, verified as a
 *                                                  phone's registration would be
 *   GET  /coverage?kind=&value=                     what archiving a rule would cover, asked before archiving
 *   POST /archive    {rule: {kind, value}, reason?}  archives by URL, package, domain or account
 *   POST /unarchive  {rule: {kind, value}}
 *   GET  /rules?cursor=                             the archive rules, newest first
 *
 * Archiving, unarchiving, each URL registered and each export are recorded in the admin audit log
 * (`admin_action_audit_logs`, the admin portal's Audit log page) with the Organization Admin's email.
 * A malformed request is `400 invalid_request`.
 */

import {
  ADMIN_REGISTRY_QUERY_MAX_LENGTH,
  ADMIN_REGISTRY_REASON_MAX_LENGTH,
  ADMIN_REGISTRY_REGISTER_MAX_URLS,
  ADMIN_REGISTRY_RULE_KINDS,
  ADMIN_REGISTRY_STATUSES,
  ADMIN_REGISTRY_VERIFICATIONS,
  type AdminRegistryArchiveResponse,
  type AdminRegistryRegisterResponse,
  type AdminRegistryUnarchiveResponse,
} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {bodyLimit} from "hono/body-limit"
import {z} from "zod"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {
  distinctUrls,
  listArchiveRules,
  listRegistryEntries,
  registerUrlsAsAdmin,
  registryCoverage,
  registryCsv,
  REGISTRY_CURSOR_PATTERN,
  requireArchiveRule,
} from "../../services/registry/registry-admin.service"
import {archive, RegistryRequestError, unarchive, type RegistryArchiveRule} from "../../services/registry/registry.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {principalLabel} from "../middleware/principal.middleware"
import {readJsonObject} from "../workspaces/request"

/** A list of 50 URLs, each up to 2,048 characters, fits with room to spare. */
const BODY_LIMIT_BYTES = 256 * 1024
const MAX_URL_LENGTH = 2048
/** The longest a rule's value can be: a URL. */
const MAX_RULE_VALUE_LENGTH = MAX_URL_LENGTH

const cursorSchema = z.string().regex(REGISTRY_CURSOR_PATTERN).optional()

const listQuerySchema = z.object({
  q: z.string().max(ADMIN_REGISTRY_QUERY_MAX_LENGTH).optional(),
  status: z.enum(ADMIN_REGISTRY_STATUSES).optional(),
  verification: z.enum(ADMIN_REGISTRY_VERIFICATIONS).optional(),
  cursor: cursorSchema,
})

const ruleSchema = z.object({
  kind: z.enum(ADMIN_REGISTRY_RULE_KINDS),
  value: z.string().min(1).max(MAX_RULE_VALUE_LENGTH),
})

const archiveSchema = z.object({rule: ruleSchema, reason: z.string().max(ADMIN_REGISTRY_REASON_MAX_LENGTH).optional()})
const unarchiveSchema = z.object({rule: ruleSchema})
/** Blank lines are allowed and dropped; the body limit bounds how many there can be. */
const registerSchema = z.object({urls: z.array(z.string().max(MAX_URL_LENGTH))})

const app = new Hono<AppEnv>()

app.use(
  "*",
  bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: c => c.json({error: "payload_too_large", error_description: "request body too large"}, 413),
  }),
)

/** `schema`'s reading of `value`, or a 400 saying what was expected. */
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, expected: string): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new InvalidRequest(expected)
  return parsed.data
}

/** A rule Core can keep, in its form; a 400 for one that can't name any entry. */
function validRule(rule: RegistryArchiveRule): RegistryArchiveRule {
  try {
    return requireArchiveRule(rule)
  } catch (error) {
    if (error instanceof RegistryRequestError) throw new InvalidRequest(error.message)
    throw error
  }
}

/** Who did it, for the audit log and a rule's author: the Organization Admin's email. */
function actor(c: AppContext): string {
  return principalLabel(c.get("principal")!)
}

function audit(
  c: AppContext,
  event: {action: string; targetType: string; targetId: string; reason?: string | null; metadata?: Record<string, unknown>},
) {
  return {
    adminId: actor(c),
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    reason: event.reason ?? null,
    metadata: event.metadata ?? null,
  }
}

const ruleTarget = (rule: RegistryArchiveRule) => `${rule.kind}:${rule.value}`

app.get("/entries", async c => {
  const query = parse(
    listQuerySchema,
    {
      q: c.req.query("q"),
      status: c.req.query("status") || undefined,
      verification: c.req.query("verification") || undefined,
      cursor: c.req.query("cursor") || undefined,
    },
    `q is at most ${ADMIN_REGISTRY_QUERY_MAX_LENGTH} characters, status is active or archived, verification is verified or phone_reported, and cursor is a page's next`,
  )
  c.header("cache-control", "no-store")
  return c.json(await listRegistryEntries(query))
})

app.get("/export", async c => {
  await AdminActionAuditLogModel.create(audit(c, {action: "miniapp_registry.export", targetType: "miniapp_registry", targetId: "entries"}))
  const lines = registryCsv()
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const {value, done} = await lines.next()
        if (done) controller.close()
        else controller.enqueue(encoder.encode(value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await lines.return(undefined)
    },
  })
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="miniapp-registry.csv"',
      "cache-control": "no-store",
    },
  })
})

app.post("/register", async c => {
  const principal = c.get("principal")!
  if (principal.kind !== "user") return c.json({error: "forbidden", error_description: "a signed-in person is required"}, 403)
  const body = parse(registerSchema, await readJsonObject(c), "body must be {urls: [miniapp URLs]}")
  const urls = distinctUrls(body.urls)
  if (urls.length === 0 || urls.length > ADMIN_REGISTRY_REGISTER_MAX_URLS) {
    throw new InvalidRequest(`urls must name 1 to ${ADMIN_REGISTRY_REGISTER_MAX_URLS} miniapp URLs`)
  }
  const results = await registerUrlsAsAdmin(urls, {mentraUserId: principal.mentraUserId, tenantId: principal.tenantId})
  await AdminActionAuditLogModel.insertMany(
    results.map((result, index) =>
      audit(c, {
        action: "miniapp_registry.register",
        targetType: "miniapp_url",
        targetId: urls[index]!.key,
        metadata: {result: result.result},
      }),
    ),
  )
  const response: AdminRegistryRegisterResponse = {results}
  c.header("cache-control", "no-store")
  return c.json(response)
})

app.get("/coverage", async c => {
  const rule = parse(ruleSchema, {kind: c.req.query("kind"), value: c.req.query("value")}, "kind and value must name an archive rule")
  c.header("cache-control", "no-store")
  return c.json(await registryCoverage(validRule(rule)))
})

app.post("/archive", async c => {
  const body = parse(archiveSchema, await readJsonObject(c), "body must be {rule: {kind, value}, reason?}")
  const rule = validRule(body.rule)
  const reason = body.reason?.trim() ?? ""
  const result: AdminRegistryArchiveResponse = await archive(rule, {reason, createdBy: actor(c)})
  await AdminActionAuditLogModel.create(
    audit(c, {
      action: "miniapp_registry.archive",
      targetType: "miniapp_registry_rule",
      targetId: ruleTarget(result.rule),
      reason: reason || null,
      metadata: {created: result.created, entriesArchived: result.entriesArchived},
    }),
  )
  return c.json(result)
})

app.post("/unarchive", async c => {
  const body = parse(unarchiveSchema, await readJsonObject(c), "body must be {rule: {kind, value}}")
  const result: AdminRegistryUnarchiveResponse = await unarchive(validRule(body.rule))
  await AdminActionAuditLogModel.create(
    audit(c, {
      action: "miniapp_registry.unarchive",
      targetType: "miniapp_registry_rule",
      targetId: ruleTarget(result.rule),
      metadata: {removed: result.removed, entriesRestored: result.entriesRestored},
    }),
  )
  return c.json(result)
})

app.get("/rules", async c => {
  const cursor = parse(cursorSchema, c.req.query("cursor") || undefined, "cursor is a page's next")
  c.header("cache-control", "no-store")
  return c.json(await listArchiveRules({cursor}))
})

export default app
