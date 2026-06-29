/**
 * pairing facade — `toolkit.pairing`: scan for nearby glasses + pair. Scan state
 * (searching + results) comes from the island core store; scan/connect go over the
 * bluetooth-sdk; pair-failure / not-ready are the bluetooth-sdk events.
 *
 * (Connect-the-already-paired-default is `toolkit.glasses.connectDefault()`; this
 * facade is the first-time discovery + pair flow.)
 */
import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {PairFailureEvent, GlassesNotReadyEvent} from "@mentra/bluetooth-sdk"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import {waitForGlassesReady} from "../services/GlassesReadiness"
import {
  logAutomaticReportSubmissionStatus,
  toAutomaticReportSubmissionStatus,
  type AutomaticReportSubmissionStatus,
} from "../services/AutomaticReportResult"
import {pushAllBluetoothSettings} from "../services/GlassesSettingsSync"
import {submitAutomaticReport} from "./reports"

export interface PairingReadyWaitOptions {
  deviceModel?: string
  deviceName?: string
  timeoutMs?: number
  route?: string
  signal?: AbortSignal
}

const DEFAULT_PAIRING_BOOT_TIMEOUT_MS = 35_000
const DEFAULT_PAIRING_ROUTE = "/pairing/loading"
const LOG_TAG = "PairingTimeoutReport"

export async function submitPairingBootTimeoutReport(params: {
  deviceModel?: string
  deviceName?: string
  showGlassesBooting: boolean
  elapsedMs: number
  route?: string
}): Promise<AutomaticReportSubmissionStatus> {
  const {deviceModel, deviceName, showGlassesBooting, elapsedMs, route = DEFAULT_PAIRING_ROUTE} = params
  const result = await submitAutomaticReport({
    kind: "automatic",
    trigger: {
      type: "automatic",
      source: "pairing_loading",
      reason: "glasses_connect_timeout",
    },
    report: {
      expectedBehavior: `Glasses should connect successfully within ${Math.round(elapsedMs / 1000)} seconds.`,
      actualBehavior: JSON.stringify(
        {
          deviceModel,
          deviceName,
          showGlassesBooting,
          elapsedMs,
          route,
        },
        null,
        2,
      ),
      systemPriority: "medium",
    },
    throttleKey: `pairing_timeout|${deviceModel || "unknown"}|${deviceName || "unknown"}`,
  })

  const status = toAutomaticReportSubmissionStatus(result)
  logAutomaticReportSubmissionStatus(LOG_TAG, status, deviceModel, deviceName)
  return status
}

async function waitForReadyDuringPairing(options: PairingReadyWaitOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAIRING_BOOT_TIMEOUT_MS
  let showGlassesBooting = false
  const notReadySub = BluetoothSdk.addListener("glasses_not_ready", () => {
    showGlassesBooting = true
  })

  try {
    const ready = await waitForGlassesReady({
      getConnection: () => useGlassesStore.getState().connection,
      subscribe: (listener) => useGlassesStore.subscribe((state) => state.connection, listener),
      timeoutMs,
      signal: options.signal,
    })

    if (!ready && !options.signal?.aborted) {
      void submitPairingBootTimeoutReport({
        deviceModel: options.deviceModel,
        deviceName: options.deviceName,
        showGlassesBooting,
        elapsedMs: timeoutMs,
        route: options.route,
      }).catch((error) => {
        console.error(`[${LOG_TAG}] Unexpected error:`, error)
      })
    }

    return ready
  } finally {
    notReadySub.remove()
  }
}

export const pairing = {
  /** Start scanning for nearby glasses. Results land on `searchResults()`/`onFound()`. */
  scan: (...args: Parameters<typeof BluetoothSdk.startScan>) => BluetoothSdk.startScan(...args),
  /** Whether a scan is currently in progress. */
  scanning: (): boolean => useCoreStore.getState().searching,
  /** The current scan results (snapshot). */
  searchResults: () => useCoreStore.getState().searchResults,
  /** Subscribe to scan-result changes; fires only when they change. Returns an unsubscribe. */
  onFound: (cb: (results: ReturnType<typeof useCoreStore.getState>["searchResults"]) => void): (() => void) => {
    let last = JSON.stringify(useCoreStore.getState().searchResults)
    return useCoreStore.subscribe(() => {
      const results = useCoreStore.getState().searchResults
      const key = JSON.stringify(results)
      if (key === last) return
      last = key
      cb(results)
    })
  },

  /** Pair with (connect to) a discovered device. */
  pair: async (...args: Parameters<typeof BluetoothSdk.connect>): Promise<void> => {
    await pushAllBluetoothSettings()
    return BluetoothSdk.connect(...args)
  },
  /** Set a device as the default for subsequent `glasses.connectDefault()`. */
  setDefault: (...args: Parameters<typeof BluetoothSdk.setDefaultDevice>) => BluetoothSdk.setDefaultDevice(...args),

  /** Subscribe to pairing failures; returns an unsubscribe. */
  onPairFailure: (cb: (event: PairFailureEvent) => void): (() => void) => {
    const sub = BluetoothSdk.addListener("pair_failure", cb)
    return () => sub.remove()
  },
  /** Subscribe to glasses-not-ready events during pairing; returns an unsubscribe. */
  onGlassesNotReady: (cb: (event: GlassesNotReadyEvent) => void): (() => void) => {
    const sub = BluetoothSdk.addListener("glasses_not_ready", cb)
    return () => sub.remove()
  },
  /** Wait for paired glasses to finish booting; island files the timeout diagnostic. */
  waitForReady: waitForReadyDuringPairing,
}
