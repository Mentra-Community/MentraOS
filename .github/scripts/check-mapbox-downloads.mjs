import path from "node:path"
import {fileURLToPath} from "node:url"

// A small, published SDK POM exercises Downloads:Read without downloading an SDK.
// This probe does not select or change the versions used by either native build.
export const MAPBOX_PROBE_URL = "https://api.mapbox.com/downloads/v2/releases/maven/com/mapbox/navigationcore/navigation/3.25.0/navigation-3.25.0.pom"

export async function checkMapboxDownloads(token, fetchImpl = fetch) {
  if (!token?.trim()) throw new Error("MAPBOX_DOWNLOADS_TOKEN is missing. Configure a Mapbox secret token with Downloads:Read in GitHub Actions secrets.")
  let response
  try {
    response = await fetchImpl(MAPBOX_PROBE_URL, {
      headers: {Authorization: `Basic ${Buffer.from(`mapbox:${token.trim()}`).toString("base64")}`},
      signal: AbortSignal.timeout(15_000),
    })
    await response.body?.cancel()
  } catch {
    // Provider errors and response bodies can contain credentials; never echo them.
    throw new Error("Mapbox SDK download check could not reach the download service. Check connectivity and retry.")
  }
  if ([401, 403].includes(response.status))
    throw new Error(`Mapbox SDK download authentication failed (HTTP ${response.status}). Check MAPBOX_DOWNLOADS_TOKEN and its Downloads:Read permission in GitHub Actions secrets.`)
  if (!response.ok) throw new Error(`Mapbox SDK download check failed (HTTP ${response.status}). Check the Mapbox download service and probe URL before retrying.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkMapboxDownloads(process.env.MAPBOX_DOWNLOADS_TOKEN)
    console.log("Mapbox SDK download authentication passed.")
  } catch (error) {
    console.error(`::error::${error.message}`)
    process.exitCode = 1
  }
}
