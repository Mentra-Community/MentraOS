import type {WifiSearchResult} from "@mentra/engine"

import {mergeWifiScanResults} from "@/utils/wifi/WifiScanUtils"

const network = (ssid: string, signalStrength: number): WifiSearchResult => ({
  ssid,
  requiresPassword: true,
  signalStrength,
})

describe("mergeWifiScanResults", () => {
  it("accumulates networks streamed in separate chunks", () => {
    const firstChunk = [network("Mentra", -31)]
    const secondChunk = [network("ATT3hyzFEa", -77)]

    expect(mergeWifiScanResults(firstChunk, secondChunk)).toEqual([...firstChunk, ...secondChunk])
  })

  it("keeps only the first result for a duplicate SSID", () => {
    const current = [network("Mentra", -31)]

    expect(mergeWifiScanResults(current, [network("Mentra", -45)])).toBe(current)
  })
})
