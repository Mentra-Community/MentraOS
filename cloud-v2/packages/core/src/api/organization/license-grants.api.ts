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
 */

import {
  checkLicenseGrantRequest,
  isLicenseGrantIdempotencyKey,
  LICENSE_GRANT_IDEMPOTENCY_HEADER,
  LICENSE_GRANT_LIMITS,
  licenseGrantEndProblem,
  parseLicenseGrant,
  parseLicenseGrantEnd,
} from "@mentra/workspace-contract"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {forwardedCredential, forwardedUser, forwardJson} from "../../services/forwarding/forward"
import {DEFAULT_FORWARDING_LIMITS} from "../../services/forwarding/upstream-url"
import {portalModuleConfig} from "../../services/portal-modules/portal-modules"
import {getWorkspace} from "../../services/workspaces/workspace.service"
import type {AppContext} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {principalLabel} from "../middleware/principal.middleware"
import {readJsonObject} from "../workspaces/request"

/**
 * How long Core waits for billing to make a grant: billing asks its payment processor several things, and a repeat
 * with the same key is safe.
 */
export const LICENSE_GRANT_TIMEOUT_MS = 60_000

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

  const scope = {kind: "workspace", workspaceId} as const
  const response = await forwardJson(c, {
    upstream: {
      service: "billing-license-grants",
      label: "License grant",
      unavailableError: "billing_unavailable",
      baseUrl: config.baseUrl,
      secret: config.secret,
      limits: {...DEFAULT_FORWARDING_LIMITS, timeoutMs: LICENSE_GRANT_TIMEOUT_MS},
    },
    path: `/v1/portal/workspaces/${encodeURIComponent(workspaceId)}/license-grants`,
    query: "",
    audience: "organization",
    body: JSON.stringify(checked.request),
    principal: () => (principal.kind === "user" ? forwardedUser(principal, scope) : forwardedCredential(principal, scope)),
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
