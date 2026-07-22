/**
 * Read-only report access for the private Mentra Dev Agent.
 *
 * This route intentionally exposes only report detail and artifact reads. It
 * does not share the broader admin router or accept human session credentials.
 */

import { Hono } from "hono";
import { getReportArtifact, getReportDetail } from "../admin/reports.api";
import { reportAgentAuth } from "../middleware/report-agent-auth.middleware";
import type { AppEnv } from "../../types/hono.types";

const app = new Hono<AppEnv>();

app.use("*", reportAgentAuth);
app.get("/health", c => c.json({ ok: true }));
app.get("/:reportId", getReportDetail);
app.get("/:reportId/artifacts/:artifactId", getReportArtifact);

export default app;
