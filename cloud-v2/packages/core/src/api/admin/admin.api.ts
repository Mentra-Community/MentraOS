import type {OrganizationCapability, PrincipalResponse} from "@mentra/workspace-contract"
import {Hono, type MiddlewareHandler} from "hono"
import {organizationCapabilities} from "../../services/workspaces/authorization.service"
import {listWorkspacesForUser} from "../../services/workspaces/workspace.service"
import type {AppEnv} from "../../types/hono.types"
import {adminFleetApi} from "../fleet/fleet-forwarding"
import {principalAuth, requireOrganizationCapability} from "../middleware/principal.middleware"
import reports from "./reports.api"
import {createRoutineCatalogApi} from "./routine-catalog.api"
import {createRoutinePreferencesApi} from "./routine-preferences.api"
import supportProfiles from "./support-profiles.api"
import testRuns from "./test-runs.api"
import testDispatches from "./test-dispatches.api"

/**
 * Core's admin surface, reached directly by the admin console and by CLI
 * tooling. It does not sit behind another service: report triage is needed
 * most when something else is down.
 *
 * `/health` is open. Everything else needs a principal (`principalAuth`: a
 * signed-in person or a Core credential), and each area then needs its own
 * organization capability, an Organization Admin having all of them and an
 * operator key (`mak_`) only the scopes it was created with:
 *
 *  - `/reports`: `organization.incidents.read`;
 *  - `/support-profiles`: `organization.supportProfiles.read`;
 *  - `/test-runs`, `/routine-catalog`, `/routines`, `/test-routines`, `/test-builds`, `/test-dispatches`:
 *    `organization.testing.read`, and `organization.testing.manage` for anything that writes.
 *
 * The principal gate is router-wide and the capability gates are per area, so
 * a route mounted here later can ask for less: `/me` needs only a principal, and
 * so does `/fleet`, which forwards to the optional Fleet integration (a workspace
 * admin who is not an Organization Admin must reach it; Fleet decides what they
 * may do). No capability gate may match `/fleet`.
 */
const app = new Hono<AppEnv>()
app.get("/health", c => c.json({status: "ok", service: "cloud-core-admin"}))
app.use("*", principalAuth)

/** Who is calling and what they may do here; open to every principal. */
app.get("/me", async c => {
  const principal = c.get("principal")
  if (!principal) return c.json({error: "unauthorized"}, 401)
  const body: {
    authenticated: true
    user: {mentraUserId: string; email: string | null} | null
    credential: {credentialId: string; label: string} | null
    organization: {organizationId: string; capabilities: OrganizationCapability[]}
    workspaces: PrincipalResponse["workspaces"]
  } = {
    authenticated: true,
    user: principal.kind === "user" ? {mentraUserId: principal.mentraUserId, email: principal.email} : null,
    credential:
      principal.kind === "credential" ? {credentialId: principal.credentialId, label: principal.label} : null,
    organization: {
      organizationId: principal.organizationId,
      // Sorted so the answer does not depend on how the set was built.
      capabilities: [...organizationCapabilities(principal)].sort(),
    },
    workspaces: principal.kind === "user" ? await listWorkspacesForUser(principal.mentraUserId) : [],
  }
  return c.json(body)
})

// The Fleet integration authorizes its own callers, so nothing below gates `/fleet`.
app.route("/fleet", adminFleetApi)

const readsIncidents = requireOrganizationCapability("organization.incidents.read")
const readsSupportProfiles = requireOrganizationCapability("organization.supportProfiles.read")
const readsTesting = requireOrganizationCapability("organization.testing.read")
const managesTesting = requireOrganizationCapability("organization.testing.manage")

/**
 * Testing is read-only for `GET` and `HEAD` and a write for any other method. Deciding by method
 * keeps a route added later fail-closed: a write needs `manage` unless it is a plain read.
 */
const testingGate: MiddlewareHandler<AppEnv> = (c, next) =>
  (c.req.method === "GET" || c.req.method === "HEAD" ? readsTesting : managesTesting)(c, next)

// A gate goes on before the routes it covers. `/x/*` also matches `/x`.
app.use("/reports/*", readsIncidents)
app.use("/support-profiles/*", readsSupportProfiles)
app.use("/test-runs/*", testingGate)
app.use("/routine-catalog/*", testingGate)
app.use("/routines/*", testingGate)
app.use("/test-routines/*", testingGate)
app.use("/test-builds/*", testingGate)
app.use("/test-dispatches/*", testingGate)

app.route("/reports", reports)
app.route("/support-profiles", supportProfiles)
app.route("/test-runs", testRuns)
app.route("/routine-catalog", createRoutineCatalogApi())
app.route("/routines", createRoutinePreferencesApi())
app.route("/", testDispatches)
export default app
