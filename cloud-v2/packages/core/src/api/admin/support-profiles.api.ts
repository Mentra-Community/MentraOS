import {Hono} from "hono"
import {z} from "zod"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {ReportModel} from "../../models/report.model"
import {SupportProfileModel} from "../../models/support-profile.model"
import {UserModel} from "../../models/user.model"
import {findUserByEmail} from "../../services/account/gotrue.client"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {GLASSES_FIRMWARE_CRASH_SOURCE, readReportArtifact} from "../../services/report.service"
import {InvalidRequest} from "../../types/oauth.types"

const app = new Hono<AppEnv>()
const querySchema = z.object({email: z.string().email().max(320)}).strict()

app.get("/lookup", lookupByEmail)
app.get("/bes-log/:reportId", readBesLog)

/**
 * The saved BES firmware log of a firmware-crash report, readable with the
 * support-profile capability alone (the incident routes need a different one).
 * Only a glasses_firmware log of an automatic crash report is served, and each
 * read is audited like the lookup that listed it.
 */
async function readBesLog(c: AppContext) {
  const reportId = (c.req.param("reportId") ?? "").trim()
  const report = reportId
    ? await ReportModel.findOne({reportId, kind: "automatic", "trigger.source": GLASSES_FIRMWARE_CRASH_SOURCE}, {mentraUserId: 1, artifacts: 1}).lean()
    : null
  const logs = (report?.artifacts ?? []).filter((artifact) => artifact.type === "logs" && artifact.source === "glasses_firmware")
  const newest = logs[logs.length - 1]
  if (!report || !newest) return c.json({error: "not_found", error_description: "BES log not found"}, 404)
  await AdminActionAuditLogModel.create({
    adminId: c.var.developer?.email || c.var.developer?.developerId || "admin",
    action: "support_profile.read_bes_log",
    targetType: "user_support_profile",
    targetId: report.mentraUserId,
    reason: null,
    metadata: {reportId, artifactId: newest.artifactId},
  })
  try {
    const payload = await readReportArtifact(reportId, newest.artifactId)
    if (!payload) return c.json({error: "not_found", error_description: "BES log not found"}, 404)
    return new Response(await new Response(await payload.stream()).text(), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `inline; filename="${reportId}-bes-log.json"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      },
    })
  } catch (error) {
    c.var.logger?.warn({reportId, error: (error as Error)?.message}, "BES log payload unreadable")
    return c.json({error: "not_found", error_description: "BES log payload unavailable"}, 404)
  }
}

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
    ReportModel.find({mentraUserId: user.mentraUserId}, {reportId: 1, kind: 1, status: 1, trigger: 1, artifacts: 1, createdAt: 1, updatedAt: 1})
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
    recentReports: reports.map(serializeRecentReport),
  })
}

type RecentReportRow = {
  reportId: string
  kind: string
  status: string
  trigger?: unknown
  artifacts?: Array<{type?: string | null; source?: string | null; artifactId?: string | null}> | null
  createdAt?: Date | null
  updatedAt?: Date | null
}

export function serializeRecentReport(report: RecentReportRow) {
  const trigger = report.trigger as {source?: unknown; reason?: unknown} | null | undefined
  const besLog = report.artifacts?.find((artifact) => artifact.type === "logs" && artifact.source === "glasses_firmware")
  const isBesCrash = report.kind === "automatic" && trigger?.source === GLASSES_FIRMWARE_CRASH_SOURCE
  return {
    reportId: report.reportId,
    kind: report.kind,
    status: report.status,
    triggerSource: typeof trigger?.source === "string" ? trigger.source : null,
    triggerReason: typeof trigger?.reason === "string" ? trigger.reason : null,
    isBesCrash,
    besLogArtifactId: besLog?.artifactId ?? null,
    // The route only serves automatic crash reports, so a filed report gets no link to it.
    besLogPath: isBesCrash && besLog ? `/api/admin/support-profiles/bes-log/${encodeURIComponent(report.reportId)}` : null,
    createdAt: report.createdAt?.toISOString() ?? null,
    updatedAt: report.updatedAt?.toISOString() ?? null,
    adminPath: `/api/admin/reports/${encodeURIComponent(report.reportId)}`,
  }
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
