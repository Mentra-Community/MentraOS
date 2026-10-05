/**
 * @fileoverview How many packages the Store holds for a workspace.
 *
 * Core asks before deleting a workspace, so a workspace that still owns miniapp
 * packages is never orphaned. The call is `GET
 * ${MENTRA_STORE_INTERNAL_URL}/api/internal/workspaces/:workspaceId/package-count`,
 * signed with the contract's service signature (service `core`, secret
 * `CLOUD_CORE_STORE_SERVICE_SECRET`), and the Store answers `{count: number}`.
 *
 * A deployment with no Store (either setting missing) has no packages, so the
 * count is 0. A Store that is configured but cannot be asked, or answers
 * anything but a whole count, is `store_unavailable`: deleting on a guess could
 * strand packages.
 */

import {createLogger} from "@mentra/cloud-shared"
import {SERVICE_HEADERS, signServiceRequest} from "@mentra/workspace-contract/server"
import {fail} from "./workspace-error"

const logger = createLogger("core").child({service: "store-package-count"})

/** How long the Store has to answer. */
const STORE_TIMEOUT_MS = 5_000

/** The service name Core identifies itself as to the Store. */
const SERVICE_NAME = "core"

/** The number of packages the Store holds for `workspaceId`; 0 when no Store is configured. */
export async function countStorePackages(workspaceId: string): Promise<number> {
  const storeUrl = process.env.MENTRA_STORE_INTERNAL_URL?.trim().replace(/\/+$/, "")
  const secret = process.env.CLOUD_CORE_STORE_SERVICE_SECRET?.trim()
  if (!storeUrl || !secret) return 0

  const url = new URL(`${storeUrl}/api/internal/workspaces/${encodeURIComponent(workspaceId)}/package-count`)
  const timestampMs = Date.now()
  const signature = signServiceRequest({
    method: "GET",
    // The path exactly as it goes on the wire, so the Store verifies the same bytes.
    pathWithQuery: url.pathname + url.search,
    body: "",
    timestampMs,
    secret,
  })

  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        [SERVICE_HEADERS.service]: SERVICE_NAME,
        [SERVICE_HEADERS.timestamp]: String(timestampMs),
        [SERVICE_HEADERS.signature]: signature,
        accept: "application/json",
      },
      // A redirect would carry the signed headers to another address.
      redirect: "error",
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn({err, workspaceId}, "the Store could not be reached for a package count")
    fail("store_unavailable", "could not reach the Store to check the workspace's packages")
  }
  if (!response.ok) {
    logger.warn({status: response.status, workspaceId}, "the Store refused a package count")
    fail("store_unavailable", `the Store answered ${response.status} when asked for the workspace's packages`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    fail("store_unavailable", "the Store's package count was not valid JSON")
  }
  const count = typeof body === "object" && body !== null ? (body as {count?: unknown}).count : undefined
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    fail("store_unavailable", "the Store returned an unusable package count")
  }
  return count
}
