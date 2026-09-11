import { Hono } from "hono";
import { z } from "zod";
import { adminAuth } from "../middleware/admin-auth.middleware";
import adminReports from "./reports.api";
import adminSupportProfiles from "./support-profiles.api";
import {
  PREINSTALLED_INSTALL_POLICIES,
} from "../../models/preinstalled-registry-revision.model";
import {
  PREINSTALLED_REGISTRY_ENVIRONMENTS,
} from "../../models/preinstalled-registry.model";
import { AdminActionAuditLogModel } from "../../models/admin-action-audit-log.model";
import {
  PreinstalledRegistryService,
  PreinstalledRegistryServiceError,
  type AdminIdentity,
} from "../../services/miniapps/preinstalled-registry.service";
import {
  MiniAppService,
  MiniAppServiceError,
} from "../../services/miniapps/miniapp.service";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { InvalidRequest } from "../../types/oauth.types";

const app = new Hono<AppEnv>();
const service = new PreinstalledRegistryService();
const miniapps = new MiniAppService();

const ensureRegistrySchema = z.object({
  environment: z.enum(PREINSTALLED_REGISTRY_ENVIRONMENTS),
  name: z.string().min(1).optional(),
  tenantId: z.string().min(1).nullable().optional(),
});

const createRevisionSchema = z.object({
  reason: z.string().nullable().optional(),
  entries: z.array(
    z.object({
      releaseId: z.string().min(1),
      required: z.boolean().optional(),
      installPolicy: z.enum(PREINSTALLED_INSTALL_POLICIES).optional(),
      minMobileVersion: z.string().nullable().optional(),
      maxMobileVersion: z.string().nullable().optional(),
      priority: z.number().int().optional(),
    }),
  ),
});

const reviewDecisionSchema = z.object({
  notes: z.string().nullable().optional(),
});

app.get("/health", c => c.json({ status: "ok", service: "cloud-core-admin" }));
app.use("*", adminAuth);
app.get("/me", c => c.json({
  authenticated: true,
  admin: true,
  user: c.var.developer ?? null,
}));
app.get("/submissions", getSubmissions);
app.post("/submissions/:releaseId/approve", postApproveSubmission);
app.post("/submissions/:releaseId/reject", postRejectSubmission);
app.post("/submissions/:releaseId/publish", postPublishSubmission);
app.get("/preinstalled/registries", getRegistries);
app.post("/preinstalled/registries", postRegistry);
app.get("/preinstalled/releases", getReleases);
app.get("/preinstalled/registries/:registryId/revisions", getRevisions);
app.post("/preinstalled/registries/:registryId/revisions", postRevision);
app.post("/preinstalled/registries/:registryId/revisions/:revisionId/promote", postPromoteRevision);
app.get("/audit-log", getAuditLog);
// Report triage lives in its own router; mounting it behind the adminAuth
// gate above keeps auth to a single pass per request.
app.route("/reports", adminReports);
app.route("/support-profiles", adminSupportProfiles);

async function getSubmissions(c: AppContext) {
  return c.json({ submissions: await miniapps.listAdminSubmissions() });
}

async function postApproveSubmission(c: AppContext) {
  const releaseId = requiredParam(c, "releaseId");
  const parsed = reviewDecisionSchema.safeParse(await readOptionalJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid review payload");
  try {
    const release = await miniapps.approveRelease({ releaseId, adminId: admin(c).adminId, notes: parsed.data.notes });
    await audit(c, "release.approve", "miniapp_release", releaseId, parsed.data.notes ?? null, { release });
    return c.json({ release });
  } catch (error) {
    return serviceError(error);
  }
}

async function postRejectSubmission(c: AppContext) {
  const releaseId = requiredParam(c, "releaseId");
  const parsed = reviewDecisionSchema.safeParse(await readOptionalJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid review payload");
  try {
    const release = await miniapps.rejectRelease({ releaseId, adminId: admin(c).adminId, notes: parsed.data.notes });
    await audit(c, "release.reject", "miniapp_release", releaseId, parsed.data.notes ?? null, { release });
    return c.json({ release });
  } catch (error) {
    return serviceError(error);
  }
}

async function postPublishSubmission(c: AppContext) {
  const releaseId = requiredParam(c, "releaseId");
  const parsed = reviewDecisionSchema.safeParse(await readOptionalJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid publish payload");
  try {
    const release = await miniapps.publishRelease({ releaseId, adminId: admin(c).adminId, notes: parsed.data.notes });
    await audit(c, "release.publish", "miniapp_release", releaseId, parsed.data.notes ?? null, { release });
    return c.json({ release });
  } catch (error) {
    return serviceError(error);
  }
}

async function getRegistries(c: AppContext) {
  return c.json({ registries: await service.listRegistries() });
}

async function postRegistry(c: AppContext) {
  const parsed = ensureRegistrySchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid registry payload");
  return c.json({ registry: await service.ensureRegistry(admin(c), parsed.data) }, 201);
}

async function getReleases(c: AppContext) {
  return c.json({ releases: await service.listPublishableReleases() });
}

async function getRevisions(c: AppContext) {
  return c.json({ revisions: await service.listRevisions(requiredParam(c, "registryId")) });
}

async function postRevision(c: AppContext) {
  const parsed = createRevisionSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid revision payload");
  try {
    const revision = await service.createRevision(admin(c), requiredParam(c, "registryId"), parsed.data);
    await audit(c, "preinstalled_registry.revision.create", "preinstalled_registry", requiredParam(c, "registryId"), parsed.data.reason ?? null, { revision });
    return c.json({ revision }, 201);
  } catch (error) {
    return serviceError(error);
  }
}

async function postPromoteRevision(c: AppContext) {
  try {
    const result = await service.promoteRevision(
      admin(c),
      requiredParam(c, "registryId"),
      requiredParam(c, "revisionId"),
    );
    await audit(c, "preinstalled_registry.revision.promote", "preinstalled_registry_revision", requiredParam(c, "revisionId"), result.revision.reason, result);
    return c.json(result);
  } catch (error) {
    return serviceError(error);
  }
}

async function getAuditLog(c: AppContext) {
  const logs = await AdminActionAuditLogModel.find({})
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
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
  });
}

function admin(c: AppContext): AdminIdentity {
  return { adminId: c.var.developer?.email || c.var.developer?.developerId || "admin" };
}

function requiredParam(c: AppContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new InvalidRequest(`missing ${name}`);
  return value;
}

async function readJsonBody(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new InvalidRequest("request body must be a JSON object");
}

async function readOptionalJsonBody(c: AppContext): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new InvalidRequest("request body must be a JSON object");
}

async function audit(
  c: AppContext,
  action: string,
  targetType: string,
  targetId: string,
  reason: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await AdminActionAuditLogModel.create({
    adminId: admin(c).adminId,
    action,
    targetType,
    targetId,
    reason,
    metadata,
  });
}

function serviceError(error: unknown) {
  if (error instanceof PreinstalledRegistryServiceError) {
    return new Response(
      JSON.stringify({ error: error.code, error_description: error.message }),
      {
        status: error.status,
        headers: { "content-type": "application/json" },
      },
    );
  }
  if (error instanceof MiniAppServiceError) {
    return new Response(
      JSON.stringify({ error: error.code, error_description: error.message }),
      {
        status: error.status,
        headers: { "content-type": "application/json" },
      },
    );
  }
  throw error;
}

export default app;
