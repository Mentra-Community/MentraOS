import {engine, type AppPermissionReceipt} from "@mentra/engine"

/** Reuse the diagnostic URL transport without navigation, auth, or an incident.
 * Only a nonce is accepted; no permission request or caller-selected output path. */
export async function publishPermissionStatusRequest(link: string): Promise<AppPermissionReceipt> {
  const url = new URL(link)
  const ids = url.searchParams.getAll("request_id")
  const requestId = ids[0] ?? ""
  if (
    url.protocol !== "com.mentra:" || url.hostname !== "test" || url.pathname !== "/permissions" ||
    url.username || url.password || url.port || url.hash ||
    ids.length !== 1 || requestId.trim() !== requestId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId) ||
    [...url.searchParams.keys()].some((key) => key !== "request_id")
  ) {
    throw new Error("Expected a Mentra permission-status link with one bounded request_id")
  }
  return engine.permissions.writeStatusReceipt(requestId)
}
