import {Hono} from "hono"
import type {AppEnv} from "../../types/hono.types"
import {adminAuth} from "../middleware/admin-auth.middleware"
import reports from "./reports.api"
import supportProfiles from "./support-profiles.api"
import testRuns from "./test-runs.api"

/**
 * Core's admin surface, reached directly by the admin console and by CLI
 * tooling. It does not sit behind another service: report triage is needed
 * most when something else is down.
 */
const app = new Hono<AppEnv>()
app.get("/health", c => c.json({status: "ok", service: "cloud-core-admin"}))
app.use("*", adminAuth)
app.get("/me", c => c.json({authenticated: true, admin: true, user: c.var.developer ?? null}))
app.route("/reports", reports)
app.route("/support-profiles", supportProfiles)
app.route("/test-runs", testRuns)
export default app
