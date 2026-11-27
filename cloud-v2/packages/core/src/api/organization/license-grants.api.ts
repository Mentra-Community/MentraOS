/**
 * @fileoverview License grants: `POST /api/organization/workspaces/:workspaceId/license-grants`, which gives a
 * workspace a number of licenses of a product until a date, without a sale through the workspace portal. It is for a
 * sale made some other way (by a reseller, for a pilot, prepaid by invoice), whose money is collected outside billing.
 *
 * The organization API mounts it behind `requirePersonOrOperatorKey` and `organization.licenses.grant`
 * (`organization.api.ts`), as its other routes: an Organization Admin holds the capability, and so does an operator key
 * created with it. A key is forwarded as itself, with its name and its creator (`forwardedCredential`), and the admin
 * action log names it as Core's audit names every key's act (`principalLabel`).
 *
 * The request is `{product, seats, endsAt, note?}` with the caller's key in the `Idempotency-Key` header, checked by
 * the contract's `checkLicenseGrantRequest` (400 `invalid_request` otherwise, with a sentence saying why). Of when it
 * ends, Core refuses only an end more than 730 days away (`licenseGrantEndProblem`, `too_late`), which no grant made
 * before could have: an end that is past or less than an hour away may be a repeat's, which billing answers with the
 * grant the key made, so billing holds only a new grant to it. The workspace must be active (404 `workspace_not_found` otherwise), and billing installed on this Core (503
 * `billing_unavailable` otherwise). Core then forwards the request as it checked it, never as it came, to billing's
 * `POST /v1/portal/workspaces/:workspaceId/license-grants`, signed as every forwarded request is
 * (`services/forwarding/forward.ts`), with the caller as its principal (`forwardedUser`, or `forwardedCredential` for
 * a key) and the workspace as its scope. Billing makes the grant and answers a `LicenseGrant`: 201 for a new one, 200
 * for one an earlier request with the same idempotency key made. Core checks the answer (`parseLicenseGrant`; one that
 * does not parse is 503 `billing_unavailable`, which is safe to retry with the same key), records it in the admin
 * action log (`workspace.licenses.granted`, by `principalLabel`, with the note as its reason; a record that fails is
 * logged, and the grant still answered) and answers it. Billing's
 * refusals (`already_licensed`, `not_for_sale`, `idempotency_conflict`...) reach the caller as billing gave them.
 *
 * The license reaches Core as any subscription's does, through billing's license writes, within seconds; the caller
 * then assigns its seats with the workspace's seat-assignment routes. See `docs/licenses.md`.
 *
 * Ending a grant early: `POST /api/organization/workspaces/:workspaceId/license-grants/:product/end`, behind the same
 * two guards, ends the workspace's grant of `product` at once. The path's product is a product key
 * (`isLicenseGrantProduct`; 400 `invalid_request` otherwise). The body is optional: none, or `{note?}`, a note of at
 * most 500 characters as a grant's (`checkLicenseGrantNote`), kept in the admin action log and not sent to billing.
 * The workspace must be active (404 `workspace_not_found` otherwise). A deleted workspace has no grant left to end:
 * its deletion ends its licenses in Core, in the deletion's own transaction, and billing cancels every subscription of
 * its customer when the change feed says so, so billing answers 404 for it too. Billing must be installed (503
 * `billing_unavailable` otherwise). Core forwards to billing's
 * `POST /v1/portal/workspaces/:workspaceId/license-grants/:product/end` as it forwards a grant, with the caller as
 * its principal, the workspace as its scope and no body. Billing cancels the grant's subscription and answers a
 * `LicenseGrantEnded`, which Core checks (`parseLicenseGrantEnded`, for this workspace and product; anything else is
 * 503 `billing_unavailable`: asking again is safe, and `grant_not_found` then means it had ended), records
 * (`workspace.licenses.grant_ended`, by `principalLabel`, with the note as its reason) and answers, 200. Billing's
 * refusals reach the caller as billing gave them: 404 `grant_not_found` (the workspace has no grant of the product
 * running), 409 `not_a_grant` (it bought the product, and cancels it itself), 409 `grant_renewed` (it renewed the
 * grant, which is its own subscription now), 409 `checkout_in_progress` and `reset_in_progress`.
 *
 * The license ends in Core through billing's license write, as it lapses when a grant runs out, but at once: paid
 * through the cancellation with no days added, ended, and every seat of it released.
 */

import {
  checkLicenseGrantNote,
  checkLicenseGrantRequest,
  isLicenseGrantIdempotencyKey,
  isLicenseGrantProduct,
  LICENSE_GRANT_IDEMPOTENCY_HEADER,
  LICENSE_GRANT_LIMITS,
  licenseGrantEndProblem,
  parseLicenseGrant,
  parseLicenseGrantEnd,
  parseLicenseGrantEnded,
} from "@mentra/workspace-contract"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {forwardedCredential, forwardedUser, forwardJson} from "../../services/forwarding/forward"
import {DEFAULT_FORWARDING_LIMITS} from "../../services/forwarding/upstream-url"
import {portalModuleConfig} from "../../services/portal-modules/portal-modules"
import {getWorkspace} from "../../services/workspaces/workspace.service"
import type {AppContext} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {principalLabel} from "../middleware/principal.middleware"
import {parseJsonObject, readJsonObject, type JsonObject} from "../workspaces/request"

/**
 * How long Core waits for billing to make a grant: billing asks its payment processor several things, and a repeat
 * with the same key is safe.
 */
export const LICENSE_GRANT_TIMEOUT_MS = 60_000

/**
 * Forwards a request about `workspaceId`'s grants to billing's `/v1/portal/workspaces/<workspaceId><path>`, signed,
 * with the caller as its principal (the person, or the key) and the workspace as its scope, and `body` in place of
 * whatever the caller sent.
 */
function forwardToBilling(
  c: AppContext,
  config: {baseUrl: URL; secret: string},
  request: {label: string; workspaceId: string; path: string; body: string},
): Promise<Response> {
  const principal = c.get("principal")!
  const scope = {kind: "workspace", workspaceId: request.workspaceId} as const
  return forwardJson(c, {
    upstream: {
      service: "billing-license-grants",
      label: request.label,
      unavailableError: "billing_unavailable",
      baseUrl: config.baseUrl,
      secret: config.secret,
      limits: {...DEFAULT_FORWARDING_LIMITS, timeoutMs: LICENSE_GRANT_TIMEOUT_MS},
    },
    path: `/v1/portal/workspaces/${encodeURIComponent(request.workspaceId)}${request.path}`,
    query: "",
    audience: "organization",
    body: request.body,
    principal: () => (principal.kind === "user" ? forwardedUser(principal, scope) : forwardedCredential(principal, scope)),
  })
}

/** The route's handler. Mount it behind `requireOrganizationCapability("organization.licenses.grant")`. */
export async function grantLicenses(c: AppContext): Promise<Response> {
  const principal = c.get("principal")!
  const workspaceId = c.req.param("workspaceId")!
  const body = await readJsonObject(c)
  const idempotencyKey = c.req.header(LICENSE_GRANT_IDEMPOTENCY_HEADER)
  if (!isLicenseGrantIdempotencyKey(idempotencyKey)) {
    throw new InvalidRequest(
      `an ${LICENSE_GRANT_IDEMPOTENCY_HEADER} header of 1 to ${LICENSE_GRANT_LIMITS.maxIdempotencyKeyLength} visible ASCII characters is required`,
    )
  }
  // The header is the key; one in the body is not read.
  const checked = checkLicenseGrantRequest({...body, idempotencyKey})
  if (!checked.ok) throw new InvalidRequest(checked.description)
  const end = licenseGrantEndProblem(parseLicenseGrantEnd(checked.request.endsAt)!, Date.now())
  if (end?.kind === "too_late") throw new InvalidRequest(end.description)

  const workspace = await getWorkspace(workspaceId)
  if (!workspace || workspace.status !== "active") {
    return c.json({error: "workspace_not_found", error_description: "no active workspace has this ID"}, 404)
  }
  const config = portalModuleConfig("billing")
  if (config.state !== "ready") {
    return c.json({error: "billing_unavailable", error_description: "billing is not available on this Core"}, 503)
  }

  const response = await forwardToBilling(c, config, {
    label: "License grant",
    workspaceId,
    path: "/license-grants",
    body: JSON.stringify(checked.request),
  })
  if (!response.ok) return response
  const grant = parseLicenseGrant(await response.json().catch(() => null))
  if (!grant || grant.workspaceId !== workspaceId) {
    return c.json(
      {error: "billing_unavailable", error_description: "billing did not confirm the grant; repeat the request with the same Idempotency-Key"},
      503,
    )
  }
  // The grant is made whatever becomes of its record here: billing's own records name the caller too.
  await AdminActionAuditLogModel.create({
    adminId: principalLabel(principal),
    action: "workspace.licenses.granted",
    targetType: "workspace",
    targetId: workspaceId,
    reason: checked.request.note,
    metadata: {
      product: grant.product,
      seats: grant.seats,
      endsAt: grant.endsAt,
      subscriptionId: grant.subscriptionId,
      licenseId: grant.licenseId,
      replayed: grant.replayed,
    },
  }).catch((error: unknown) => {
    c.get("logger")?.error({workspaceId, failure: (error as Error)?.name ?? "Error"}, "a license grant was made but not recorded in the admin action log")
  })
  return c.json(grant, response.status === 201 ? 201 : 200)
}

/** The request's body as a JSON object when it has one, and an empty object when it has none. Anything else is a 400. */
async function readOptionalJsonObject(c: AppContext): Promise<JsonObject> {
  const text = await c.req.text().catch(() => null)
  if (text === null) throw new InvalidRequest("request body must be a JSON object")
  return text.trim() === "" ? {} : parseJsonObject(text)
}

/**
 * The handler that ends a workspace's grant of a product early (see the file header). Mount it behind
 * `requireOrganizationCapability("organization.licenses.grant")`.
 */
export async function endLicenseGrant(c: AppContext): Promise<Response> {
  const principal = c.get("principal")!
  const workspaceId = c.req.param("workspaceId")!
  const product = c.req.param("product")
  if (!isLicenseGrantProduct(product)) throw new InvalidRequest("product must be a product key, such as mentra.call.unlimited")
  const note = checkLicenseGrantNote((await readOptionalJsonObject(c)).note)
  if (!note.ok) throw new InvalidRequest(note.description)

  const workspace = await getWorkspace(workspaceId)
  if (!workspace || workspace.status !== "active") {
    return c.json({error: "workspace_not_found", error_description: "no active workspace has this ID"}, 404)
  }
  const config = portalModuleConfig("billing")
  if (config.state !== "ready") {
    return c.json({error: "billing_unavailable", error_description: "billing is not available on this Core"}, 503)
  }

  // The product as Core checked it, never as the path spelled it; the note stays in Core's admin action log.
  const response = await forwardToBilling(c, config, {
    label: "License grant end",
    workspaceId,
    path: `/license-grants/${encodeURIComponent(product)}/end`,
    body: "",
  })
  if (!response.ok) return response
  const ended = parseLicenseGrantEnded(await response.json().catch(() => null))
  if (!ended || ended.workspaceId !== workspaceId || ended.product !== product) {
    return c.json(
      {error: "billing_unavailable", error_description: "billing did not confirm that the grant ended; ask again: grant_not_found then means it had"},
      503,
    )
  }
  // The grant has ended whatever becomes of its record here: billing's own log names the caller too.
  await AdminActionAuditLogModel.create({
    adminId: principalLabel(principal),
    action: "workspace.licenses.grant_ended",
    targetType: "workspace",
    targetId: workspaceId,
    reason: note.note,
    metadata: {
      product: ended.product,
      subscriptionId: ended.subscriptionId,
      licenseId: ended.licenseId,
      endedAt: ended.endedAt,
    },
  }).catch((error: unknown) => {
    c.get("logger")?.error({workspaceId, failure: (error as Error)?.name ?? "Error"}, "a license grant was ended but not recorded in the admin action log")
  })
  return c.json(ended, 200)
}
