/** Admin-only staging test-billing reset. The production API rejects the action before touching billing. */
import {Hono} from "hono"
import {z} from "zod"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {forwardedUser, forwardJson} from "../../services/forwarding/forward"
import {DEFAULT_FORWARDING_LIMITS} from "../../services/forwarding/upstream-url"
import {finishLicenseReset, licenseResetPreview, requireStagingLicenseReset, validateLicenseReset} from "../../services/licenses/workspace-license-reset.service"
import {portalModuleConfig} from "../../services/portal-modules/portal-modules"
import type {UserPrincipal} from "../../services/signin/principal.service"
import type {AppEnv} from "../../types/hono.types"
import {requireOrganizationAdminPerson, userActor} from "../middleware/principal.middleware"
import {readJsonObject} from "../workspaces/request"

const BillingResult = z.object({licenseIds: z.array(z.string().min(1)).max(10000), canceledSubscriptions: z.number().int().nonnegative(), expiredCheckouts: z.number().int().nonnegative()})
const app = new Hono<AppEnv>()
app.use("*", requireOrganizationAdminPerson())
app.use("*", async (c, next) => {requireStagingLicenseReset(); c.header("cache-control", "no-store"); await next()})
app.get("/:workspaceId", async c => c.json(await licenseResetPreview(c.req.param("workspaceId"))))
app.post("/:workspaceId", async c => {
  const workspaceId = c.req.param("workspaceId")
  const reason = validateLicenseReset(workspaceId, await readJsonObject(c))
  await licenseResetPreview(workspaceId)
  const config = portalModuleConfig("billing")
  if (config.state !== "ready") return c.json({error: "billing_unavailable", error_description: "billing must be available before licenses can be reset"}, 503)
  const person = c.get("principal") as UserPrincipal
  await AdminActionAuditLogModel.create({adminId: person.mentraUserId, action: "workspace.licenses.reset.requested", targetType: "workspace", targetId: workspaceId, reason})
  const response = await forwardJson(c, {
    upstream: {service: "billing-reset", label: "Staging billing reset", unavailableError: "billing_unavailable", baseUrl: config.baseUrl, secret: config.secret, limits: {...DEFAULT_FORWARDING_LIMITS, timeoutMs: 120000}},
    path: `/v1/portal/workspaces/${encodeURIComponent(workspaceId)}/reset-licenses`, query: "", audience: "admin",
    principal: () => forwardedUser(person, {kind: "workspace", workspaceId}),
  })
  if (!response.ok) return response
  const parsed = BillingResult.safeParse(await response.json().catch(() => null))
  if (!parsed.success) return c.json({error: "billing_unavailable", error_description: "billing reset did not return a verified result; retry safely"}, 503)
  return c.json(await finishLicenseReset(userActor(c), workspaceId, reason, parsed.data))
})
export default app
