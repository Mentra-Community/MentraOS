/**
 * @fileoverview Internal Fleet API, mounted at `/api/internal/fleet`: what Fleet (MFM) tells Core. Fleet only:
 * `serviceAuth` authenticates every route (401 `service_unauthorized` without a valid signature) and any other
 * service is 403 `forbidden`. Bodies are at most 64 KiB (413 `payload_too_large`, `api/app.ts`).
 *
 * | Route                                            | Answers                                                       |
 * | ------------------------------------------------ | ------------------------------------------------------------- |
 * | `PUT /workspaces/:workspaceId/assigned-packages` | `{workspaceId, packageNames, revision, applied}`; 409 `stale_revision`, 404 `workspace_not_found`, 410 `workspace_deleted`, 400 |
 *
 * `PUT .../assigned-packages` takes `{packageNames, revision}`: the package names of every miniapp the
 * workspace assigns now, and Fleet's revision of that set. It replaces Core's set when the revision is newer
 * than Core's; a repeat of Core's revision answers 200 `applied: false` with the set Core keeps, and an older
 * one 409 `stale_revision` with Core's `revision`. Core names the workspace in a member's miniapp token only for
 * a package in this set (`services/workspaces/assigned-packages.service.ts`). A workspace Core never had is 404
 * `workspace_not_found`; a deleted one is 410 `workspace_deleted`, and its set is gone with it.
 */

import {WORKSPACE_NOT_FOUND_ERROR} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {
  parseAssignedPackagesWrite,
  replaceAssignedPackages,
  type AssignedPackagesAnswer,
} from "../../services/workspaces/assigned-packages.service"
import {WorkspaceError} from "../../services/workspaces/workspace-error"
import type {AppEnv} from "../../types/hono.types"
import {requireService, serviceAuth} from "../middleware/service-auth.middleware"
import {parseJsonObject} from "../workspaces/request"

const app = new Hono<AppEnv>()

// Every route is Fleet's. This also authenticates the request, so no route is open.
app.use("*", serviceAuth, requireService("fleet"))

app.put("/workspaces/:workspaceId/assigned-packages", async (c) => {
  const workspaceId = c.req.param("workspaceId")
  const write = parseAssignedPackagesWrite(parseJsonObject(c.get("serviceBody") ?? ""))
  try {
    const answer: AssignedPackagesAnswer = await replaceAssignedPackages(workspaceId, write)
    return c.json(answer)
  } catch (err) {
    // The contract's "no such workspace", as the workspace service API answers it.
    if (err instanceof WorkspaceError && err.code === "not_found") return c.json({error: WORKSPACE_NOT_FOUND_ERROR}, 404)
    throw err
  }
})

export default app
