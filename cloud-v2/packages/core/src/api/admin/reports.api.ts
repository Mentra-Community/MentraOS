/**
 * @fileoverview Admin report triage routes.
 *
 * Read-only surface behind the internal admin console's incident system:
 *   GET /            — newest-first report list (kind/category/status filters)
 *   GET /:reportId   — full report document plus its asset rows
 *   GET|HEAD /:reportId/artifacts/:artifactId — raw artifact payload bytes,
 *     honoring a single byte Range
 *
 * Mounted behind the admin console auth gate. The private report-agent router
 * reuses only the exported detail and artifact handlers, never the list route.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  getReport,
  listReports,
  readReportArtifact,
} from "../../services/report.service";
import { streamedRangeResponse } from "../../services/storage/byte-range";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { InvalidRequest } from "../../types/oauth.types";

const app = new Hono<AppEnv>();

const listQuerySchema = z.object({
  kind: z.enum(["bug", "feedback", "automatic"]).optional(),
  category: z.enum(["bug", "feedback", "internal", "testing", "automatic"]).optional(),
  status: z.enum(["collecting", "ready", "closed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.date().optional(),
});

app.get("/", getReportsList);
app.get("/:reportId", getReportDetail);
app.on(["GET", "HEAD"], "/:reportId/artifacts/:artifactId", getReportArtifact);

async function getReportsList(c: AppContext) {
  const parsed = listQuerySchema.safeParse({
    kind: c.req.query("kind"),
    category: c.req.query("category"),
    status: c.req.query("status"),
    limit: c.req.query("limit"),
    before: c.req.query("before"),
  });
  if (!parsed.success) {
    throw new InvalidRequest("invalid report list query");
  }
  return c.json({ reports: await listReports(parsed.data) });
}

export async function getReportDetail(c: AppContext) {
  const detail = await getReport(requiredParam(c, "reportId"));
  if (!detail) return c.json({ error: "not_found", error_description: "report not found" }, 404);
  return c.json(detail);
}

export async function getReportArtifact(c: AppContext) {
  const reportId = requiredParam(c, "reportId");
  const artifactId = requiredParam(c, "artifactId");

  try {
    const payload = await readReportArtifact(reportId, artifactId);
    if (!payload) return c.json({ error: "not_found", error_description: "artifact not found" }, 404);

    // User-submitted content stays inert even when its declared type is wrong.
    // HEAD and Range use verified metadata; bytes stream from the original key.
    const contentType = (payload.contentType || "").split(";")[0].trim().toLowerCase();
    const inline = INLINE_CONTENT_TYPES.has(contentType);
    return await streamedRangeResponse(c.req.raw, payload.sizeBytes, new Headers({
      "content-type": inline ? contentType : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeFilename(payload.fileName, artifactId)}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=300",
      etag: `"${payload.sha256}"`,
    }), payload.stream);
  } catch (error) {
    // The asset row exists but its blob is unreadable (rolled back or storage
    // trouble). Surface as missing rather than a bare 500; the log keeps the
    // distinction diagnosable.
    c.var.logger.warn({ reportId, artifactId, error: (error as Error)?.message }, "report artifact payload unreadable");
    return c.json({ error: "not_found", error_description: "artifact payload unavailable" }, 404);
  }
}

const INLINE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  // Stored only by explicit type=video uploads declared video/mp4 with an
  // ISO media header; not a proof that the stream is decodable.
  "video/mp4",
  "application/json",
]);

function requiredParam(c: AppContext, name: string): string {
  const value = (c.req.param(name) ?? "").trim();
  if (!value) throw new InvalidRequest(`${name} is required`);
  return value;
}

/** Client-supplied filenames go through a strict allowlist before reaching a header. */
function safeFilename(fileName: string | null, fallback: string): string {
  const cleaned = (fileName ?? "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  return cleaned || fallback;
}

export default app;
