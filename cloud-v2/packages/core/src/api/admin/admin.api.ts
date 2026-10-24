/**
 * @fileoverview Core's admin surface (`/api/admin/*`), reached by the admin
 * portal with its own session and by tooling with an operator key. It does not
 * sit behind another service: report triage is needed most when something else
 * is down.
 *
 * `/health` is open and `/auth/*` is the admin portal's sign-in. Everything
 * else needs a principal (a signed-in person or a Core credential), and each
 * area then needs its own capability. There is no blanket admin gate:
 *
 *  - `/me`: any principal; says what it may do here, whether Fleet is installed and whether the Licenses
 *    page has anything to offer;
 *  - `/reports`: `organization.incidents.read`;
 *  - `/support-profiles`: `organization.supportProfiles.read`;
 *  - `/licenses`: `organization.licenses.read`, read-only (an Organization Admin; an operator key cannot hold it);
 *  - `/registry`: `organization.registry.administer`, the miniapp registry (an Organization Admin; an operator key
 *    cannot hold it);
 *  - `/test-runs`, `/routine-catalog`, `/routines`, `/test-routines`, `/test-builds`, `/test-dispatches`:
 *    `organization.testing.read`, and `organization.testing.manage` for anything that writes;
 *  - `/workspaces`: the workspace API, for people, each route gated on the caller's
 *    standing in that workspace (an Organization Admin acts as its owner);
 *  - `/organization`: the organization API (every workspace, ownership
 *    recovery, operator keys), for people holding the organization capability;
 *  - `/audit-log`: an Organization Admin who is a person;
 *  - `/fleet`: forwarded to the optional Fleet service, for a person holding
 *    `organization.fleet.administer` (an Organization Admin). The forwarder carries its own gates.
 *
 * An Organization Admin holds every organization capability; an operator key
 * holds only the scopes it was created with; a workspace key holds none.
 */

import type {OrganizationCapability, PrincipalResponse} from "@mentra/workspace-contract"
import {Hono, type MiddlewareHandler} from "hono"
import {createMiddleware} from "hono/factory"
import {fleetInstalled} from "../../services/fleet/fleet-config"
import {anyLicenseExists} from "../../services/licenses/license-list.service"
import {portalModuleAccess, type ConfigLog} from "../../services/portal-modules/portal-modules"
import type {CorePrincipal} from "../../services/signin/principal.service"
import {organizationCapabilities, organizationView} from "../../services/workspaces/authorization.service"
import {listWorkspacesForUser} from "../../services/workspaces/workspace.service"
import type {AppEnv} from "../../types/hono.types"
import {adminFleetApi} from "../fleet/fleet-forwarding"
import {principalAuth, principalLabel, requireOrganizationCapability} from "../middleware/principal.middleware"
import {createOrganizationApi} from "../organization/organization.api"
import {createPortalAuthApi} from "../signin/portal-auth.api"
import {createWorkspacesApi} from "../workspaces/workspaces.api"
import auditLog from "./audit-log.api"
import licenses from "./licenses.api"
import registry from "./registry.api"
import reports from "./reports.api"
import {createRoutineCatalogApi} from "./routine-catalog.api"
import {createRoutinePreferencesApi} from "./routine-preferences.api"
import supportProfiles from "./support-profiles.api"
import testDispatches from "./test-dispatches.api"
import testRuns from "./test-runs.api"

/** What `GET /api/admin/me` answers. */
export interface AdminMeResponse {
  authenticated: true
  user: {mentraUserId: string; email: string | null; emailVerified: boolean; isOrganizationAdmin: boolean} | null
  credential: {credentialId: string; credentialKind: "workspace" | "organization"; label: string} | null
  organization: {capabilities: OrganizationCapability[]}
  workspaces: PrincipalResponse["workspaces"]
  /**
   * Whether the optional Fleet integration is installed on this Core. True for an install whose settings are
   * unusable too, so the admin portal can say Fleet is unavailable rather than hide a broken install.
   */
  fleet: {installed: boolean}
  /**
   * Whether the Licenses page has anything to offer this caller: they may read licenses, and billing is
   * configured on this Core or any license exists. False for everyone else, so a caller who cannot read
   * licenses learns nothing about them.
   */
  licenses: {available: boolean}
}

const app = new Hono<AppEnv>()
app.get("/health", c => c.json({status: "ok", service: "cloud-core-admin"}))
// Admin portal sign-in, ahead of the principal gate.
app.route("/auth", createPortalAuthApi("admin"))
app.use("*", principalAuth("admin"))

/** The caller's label for the audit fields the admin routes record. */
const labelCaller: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const principal = c.get("principal")!
  c.set("developer", {
    developerId: principal.kind === "user" ? principal.mentraUserId : `api_key:${principal.credentialId}`,
    email: principalLabel(principal),
  })
  await next()
})
app.use("*", labelCaller)

/** `/me` only decides what to offer; a billing misconfiguration is reported where billing is used, not here. */
const QUIET: ConfigLog = {error: () => {}}

/**
 * Whether the Licenses page has anything to offer `principal`: they hold `organization.licenses.read`, and
 * billing is configured (installed, whether or not its settings are usable: the list reads Core's own rows) or
 * any license exists. Billing is asked first, so a Core with billing never queries the licenses.
 */
async function licensesAvailable(principal: CorePrincipal): Promise<boolean> {
  // Only a person (an Organization Admin) holds it: it is not an operator key scope.
  if (principal.kind !== "user" || !organizationCapabilities(principal).has("organization.licenses.read")) return false
  if (portalModuleAccess("billing", principal, undefined, QUIET).state !== "hidden") return true
  return anyLicenseExists()
}

app.get("/me", async c => {
  const principal = c.get("principal")!
  const body: AdminMeResponse = {
    authenticated: true,
    user:
      principal.kind === "user"
        ? {
            mentraUserId: principal.mentraUserId,
            email: principal.email,
            emailVerified: principal.emailVerified,
            isOrganizationAdmin: principal.isOrganizationAdmin,
          }
        : null,
    credential:
      principal.kind === "credential"
        ? {credentialId: principal.credentialId, credentialKind: principal.credentialKind, label: principal.label}
        : null,
    organization: {capabilities: organizationView(principal).capabilities},
    workspaces: principal.kind === "user" ? await listWorkspacesForUser(principal.mentraUserId) : [],
    fleet: {installed: fleetInstalled()},
    licenses: {available: await licensesAvailable(principal)},
  }
  return c.json(body)
})

app.route("/workspaces", createWorkspacesApi())
app.route("/organization", createOrganizationApi())
app.route("/fleet", adminFleetApi)

const readsIncidents = requireOrganizationCapability("organization.incidents.read")
const readsSupportProfiles = requireOrganizationCapability("organization.supportProfiles.read")
const readsLicenses = requireOrganizationCapability("organization.licenses.read")
const administersRegistry = requireOrganizationCapability("organization.registry.administer")
const readsTesting = requireOrganizationCapability("organization.testing.read")
const managesTesting = requireOrganizationCapability("organization.testing.manage")

/**
 * Testing is read-only for `GET` and `HEAD` and a write for any other method. Deciding by method keeps a
 * route added later fail-closed: a write needs `manage` unless it is a plain read.
 */
const testingGate: MiddlewareHandler<AppEnv> = (c, next) =>
  (c.req.method === "GET" || c.req.method === "HEAD" ? readsTesting : managesTesting)(c, next)

// A gate goes on before the routes it covers. `/x/*` also matches `/x`.
app.use("/reports/*", readsIncidents)
app.use("/support-profiles/*", readsSupportProfiles)
app.use("/licenses/*", readsLicenses)
app.use("/registry/*", administersRegistry)
app.use("/test-runs/*", testingGate)
app.use("/routine-catalog/*", testingGate)
app.use("/routines/*", testingGate)
app.use("/test-routines/*", testingGate)
app.use("/test-builds/*", testingGate)
app.use("/test-dispatches/*", testingGate)

app.route("/reports", reports)
app.route("/support-profiles", supportProfiles)
app.route("/licenses", licenses)
app.route("/registry", registry)
app.route("/test-runs", testRuns)
app.route("/routine-catalog", createRoutineCatalogApi())
app.route("/routines", createRoutinePreferencesApi())
app.route("/", testDispatches)
app.route("/", auditLog)

export default app
