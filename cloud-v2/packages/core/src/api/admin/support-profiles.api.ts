import {Hono} from "hono"
import {z} from "zod"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {ReportModel} from "../../models/report.model"
import {SupportProfileModel} from "../../models/support-profile.model"
import {UserModel} from "../../models/user.model"
import {findUserByEmail} from "../../services/account/gotrue.client"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"

const app = new Hono<AppEnv>()
const querySchema = z.object({email: z.string().email().max(320)}).strict()

app.get("/lookup", lookupByEmail)

async function lookupByEmail(c: AppContext) {
  const parsed = querySchema.safeParse({email: c.req.query("email")})
  if (!parsed.success) throw new InvalidRequest("a valid email is required")

  const identity = await findUserByEmail(parsed.data.email)
  const user = identity ? await UserModel.findOne({tenantId: "mentra", tenantUserId: identity.id}).lean() : null
  const targetId = user?.mentraUserId ?? "email_lookup_miss"
  await AdminActionAuditLogModel.create({
    adminId: c.var.developer?.email || c.var.developer?.developerId || "admin",
    action: "support_profile.read",
    targetType: "user_support_profile",
    targetId,
    reason: null,
    // Never copy the queried email into durable audit metadata.
    metadata: {found: Boolean(user), query: "exact_email"},
  })
  if (!user || !identity) {
    return c.json({user: null, profile: null, devices: [], recentReports: []})
  }

  const [profile, reports] = await Promise.all([
    SupportProfileModel.findOne({mentraUserId: user.mentraUserId}).lean(),
    ReportModel.find({mentraUserId: user.mentraUserId}, {reportId: 1, kind: 1, status: 1, createdAt: 1, updatedAt: 1})
      .sort({createdAt: -1})
      .limit(10)
      .lean(),
  ])
  const currentDevice = profile?.devices.find((device) => device.deviceKey === profile.currentDeviceKey) ?? null
  return c.json({
    user: {
      mentraUserId: user.mentraUserId,
      email: identity.email,
      emailVerified: identity.emailVerified,
    },
    profile: profile
      ? {
          host: serializeHost(profile.host),
          currentDeviceId: profile.currentDeviceKey ?? null,
          currentDevice: currentDevice ? serializeDevice(currentDevice) : null,
          lastSeenAt: profile.host.receivedAt.toISOString(),
          freshness: freshness(profile.host.receivedAt),
          source: "cloud_v2_mobile_support_profile",
          updatedAt: profile.updatedAt?.toISOString() ?? null,
        }
      : null,
    devices: (profile?.devices ?? []).map(serializeDevice),
    recentReports: reports.map((report) => ({
      reportId: report.reportId,
      kind: report.kind,
      status: report.status,
      createdAt: report.createdAt?.toISOString() ?? null,
      updatedAt: report.updatedAt?.toISOString() ?? null,
      adminPath: `/api/admin/reports/${encodeURIComponent(report.reportId)}`,
    })),
  })
}

function serializeHost(host: any) {
  return {
    appVersion: host.appVersion ?? null,
    appBuild: host.appBuild ?? null,
    engineVersion: host.engineVersion ?? null,
    bluetoothSdkVersion: host.bluetoothSdkVersion ?? null,
    phonePlatform: host.phonePlatform,
    phoneModel: host.phoneModel ?? null,
    phoneOsVersion: host.phoneOsVersion ?? null,
    connectionState: host.connectionState,
    failureCode: host.failureCode ?? null,
    failureStage: host.failureStage ?? null,
    observedAt: host.observedAt.toISOString(),
    receivedAt: host.receivedAt.toISOString(),
  }
}

function serializeDevice(device: any) {
  return {
    deviceId: device.deviceKey,
    model: device.model ?? null,
    androidVersion: device.androidVersion ?? null,
    firmwareVersion: device.firmwareVersion ?? null,
    mtkFirmwareVersion: device.mtkFirmwareVersion ?? null,
    besFirmwareVersion: device.besFirmwareVersion ?? null,
    appVersion: device.appVersion ?? null,
    buildNumber: device.buildNumber ?? null,
    firstSeenAt: device.firstSeenAt.toISOString(),
    lastSeenAt: device.lastSeenAt.toISOString(),
    lastConnectedAt: device.lastConnectedAt?.toISOString() ?? null,
    observedAt: device.observedAt.toISOString(),
    freshness: freshness(device.lastSeenAt),
    source: "cloud_v2_mobile_support_profile",
  }
}

function freshness(date: Date): "fresh" | "stale" | "outdated" {
  const ageMs = Date.now() - date.getTime()
  if (ageMs <= 15 * 60_000) return "fresh"
  if (ageMs <= 24 * 60 * 60_000) return "stale"
  return "outdated"
}

export default app
