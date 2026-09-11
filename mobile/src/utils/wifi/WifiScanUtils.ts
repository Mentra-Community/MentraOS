import type {WifiSearchResult} from "@mentra/engine"

/** Append streamed scan chunks while preserving the first result for each SSID. */
export function mergeWifiScanResults(current: WifiSearchResult[], incoming: WifiSearchResult[]): WifiSearchResult[] {
  const seenSsids = new Set(current.map((network) => network.ssid))
  const newNetworks = incoming.filter((network) => {
    if (seenSsids.has(network.ssid)) {
      return false
    }
    seenSsids.add(network.ssid)
    return true
  })

  return newNetworks.length > 0 ? [...current, ...newNetworks] : current
}
