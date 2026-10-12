import {randomUUID} from "node:crypto"

// Exercise the runtime's provider APIs, not the separate SDK downloads token.
// Fixed public coordinates keep customer queries and location out of preflight.
export async function checkMapboxRuntime(token, fetchImpl = fetch) {
  if (!token?.trim()) throw new Error("MAPBOX_ACCESS_TOKEN is missing")
  const probes = [
    {
      name: "place search",
      path: "/search/searchbox/v1/suggest",
      params: {q: "San Francisco", session_token: randomUUID(), types: "poi,address,place,street", limit: "1"},
    },
    {
      name: "reverse geocoding",
      path: "/search/geocode/v6/reverse",
      params: {longitude: "-122.4194", latitude: "37.7749", types: "address,street,place", limit: "1"},
    },
  ]
  for (const probe of probes) {
    const url = new URL(probe.path, "https://api.mapbox.com")
    url.search = new URLSearchParams({...probe.params, access_token: token.trim()}).toString()
    let response
    try {
      response = await fetchImpl(url, {signal: AbortSignal.timeout(15_000), redirect: "error"})
      await response.body?.cancel()
    } catch {
      // Fetch errors can contain the credential-bearing URL; never echo them.
      throw new Error(`Mapbox runtime ${probe.name} check could not reach the provider. Check connectivity and retry.`)
    }
    if ([401, 403].includes(response.status)) {
      throw new Error(`Mapbox runtime ${probe.name} authentication failed (HTTP ${response.status}). Check MAPBOX_ACCESS_TOKEN in the selected Cloud environment.`)
    }
    if (!response.ok) {
      throw new Error(`Mapbox runtime ${probe.name} check failed (HTTP ${response.status}). Check the provider before retrying.`)
    }
  }
}
