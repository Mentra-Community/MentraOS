/**
 * @fileoverview Internal license API, mounted at `/api/internal/licenses`: how billing (the Store's billing
 * module) writes licenses into Core and reads them back. The Store only: `serviceAuth` authenticates every
 * route (401 `service_unauthorized` without a valid signature) and any other service is 403 `forbidden`.
 * The shapes are the contract's (`@mentra/workspace-contract`), spoken by `createCoreWorkspaceClient`'s
 * `putLicense` and `listLicenses`.
 *
 * | Route                                | Answers                                                                            |
 * | ------------------------------------ | ---------------------------------------------------------------------------------- |
 * | `PUT /:licenseId`                    | `LicenseWriteResponse`; 409 `stale_revision`, 404 `owner_not_found`, 400           |
 * | `GET /?ownerType=workspace&ownerId=` | `LicensesResponse`: the workspace's licenses, ended ones included, with seats used |
 *
 * `PUT` takes a `LicenseWrite` for the license the path names, and applies it only when its revision is
 * newer than Core's (`license.service`): an equal revision answers 200 `applied: false`, an older one 409
 * `stale_revision` (with Core's `revision`), and a write for a workspace that is deleted or never existed 404
 * `owner_not_found`. A malformed write, one for another license than the path's, one whose owner is not a
 * workspace (a person included) and a change of owner are 400 `invalid_request`. A list for any `ownerType`
 * but `workspace` is 400 too: a license has no other owner.
 */

import type {LicenseOwner, LicensesResponse, LicenseWriteResponse} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {applyLicenseWrite, listLicenses, parseLicenseWrite} from "../../services/licenses/license.service"
import type {AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {requireService, serviceAuth} from "../middleware/service-auth.middleware"
import {parseJsonObject} from "../workspaces/request"

const app = new Hono<AppEnv>()

// Every route is billing's. This also authenticates the request, so no route is open.
app.use("*", serviceAuth, requireService("store"))

app.put("/:licenseId", async (c) => {
  const service = c.get("service")
  if (!service) throw new Error("serviceAuth did not set the service")
  const write = parseLicenseWrite(parseJsonObject(c.get("serviceBody") ?? ""), c.req.param("licenseId"))
  const answer: LicenseWriteResponse = await applyLicenseWrite(write, {kind: "service", service, email: null})
  return c.json(answer)
})

app.get("/", async (c) => {
  const answer: LicensesResponse = {
    licenses: await listLicenses(ownerOf(c.req.query("ownerType"), c.req.query("ownerId"))),
  }
  return c.json(answer)
})

/** The owner a list asks for: `ownerType` `workspace`, the only owner a license has, and its non-blank id. */
function ownerOf(ownerType: string | undefined, ownerId: string | undefined): LicenseOwner {
  if (ownerType !== "workspace") throw new InvalidRequest('ownerType must be "workspace"')
  if (typeof ownerId !== "string" || !ownerId.trim()) throw new InvalidRequest("ownerId must be a non-empty string")
  return {type: "workspace", workspaceId: ownerId}
}

export default app
