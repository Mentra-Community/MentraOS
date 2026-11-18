/**
 * @fileoverview The admin portal's audit log (`GET /api/admin/audit-log`): the latest admin actions
 * Core recorded, such as support-profile lookups, each naming the person or key that took it. Mounted
 * inside `/api/admin` by `admin.api.ts`.
 *
 * It has no organization capability of its own and takes `organization.credentials.manage`: the log is how
 * whoever oversees keys sees what people and keys did with their admin standing, and that is who acts on it
 * (revokes a key). An Organization Admin holds it; an operator key may be created with it.
 */

import {Hono} from "hono"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import type {AppEnv} from "../../types/hono.types"
import {requireOrganizationCapability} from "../middleware/principal.middleware"

/** How many of the latest actions the log shows. */
const AUDIT_LOG_LIMIT = 100

const app = new Hono<AppEnv>()

app.get("/audit-log", requireOrganizationCapability("organization.credentials.manage"), async c => {
  const logs = await AdminActionAuditLogModel.find({}).sort({createdAt: -1}).limit(AUDIT_LOG_LIMIT).lean()
  return c.json({
    events: logs.map(log => ({
      id: log._id.toString(),
      adminId: log.adminId,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      reason: log.reason ?? null,
      metadata: log.metadata ?? null,
      createdAt: log.createdAt?.toISOString() ?? null,
    })),
  })
})

export default app
