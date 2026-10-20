/**
 * @fileoverview The admin portal's audit log (`GET /api/admin/audit-log`): the latest admin actions
 * Core recorded, such as support-profile lookups. Mounted inside `/api/admin` by `admin.api.ts`.
 * It needs an Organization Admin who is a person: it has no organization capability of its own,
 * and keys, operator keys included, are refused.
 */

import {Hono} from "hono"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import type {AppEnv} from "../../types/hono.types"
import {requireOrganizationAdminPerson} from "../middleware/principal.middleware"

/** How many of the latest actions the log shows. */
const AUDIT_LOG_LIMIT = 100

const app = new Hono<AppEnv>()

app.get("/audit-log", requireOrganizationAdminPerson(), async c => {
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
