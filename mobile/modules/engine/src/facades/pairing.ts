/**
 * pairing facade — `engine.pairing`: scan for nearby glasses + pair. Scan state
 * (searching + results) comes from the engine core store; scan/connect go over the
 * bluetooth-sdk; pair-failure / not-ready are the bluetooth-sdk events.
 *
 * (Connect-the-already-paired-default is `engine.glasses.connectDefault()`; this
 * facade is the first-time discovery + pair flow.)
 */
// Internal btsdk surface — updateBluetoothSettings (the Bluetooth Classic
// target hint) lives on the full surface, not the public entry (same reason
// the glasses facade imports internal).
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {ConnectOptions, Device, DeviceModel, PairFailureEvent, GlassesNotReadyEvent} from "@mentra/bluetooth-sdk"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import {hasDefaultDevice} from "../services/DeviceStoreHydration"
import {
  markPendingSelection,
  projectPairingIdentity,
  subscribePairingIdentity,
  type IdentitySnapshot,
} from "../services/PairingIdentity"
import {
  isGlassesConnected,
  isGlassesLinkLayerBusy,
  isGlassesReady,
  waitForGlassesReady,
} from "../services/GlassesReadiness"
import {
  logAutomaticReportSubmissionStatus,
  toAutomaticReportSubmissionStatus,
  type AutomaticReportSubmissionStatus,
} from "../services/AutomaticReportResult"
import {pushAllBluetoothSettings} from "../services/GlassesSettingsSync"
import {submitAutomaticReport} from "./reports"

export type {IdentitySnapshot} from "../services/PairingIdentity"

export interface PairingReadyWaitOptions {
  deviceModel?: string
  deviceName?: string
  timeoutMs?: number
  route?: string
  signal?: AbortSignal
}

const DEFAULT_PAIRING_BOOT_TIMEOUT_MS = 35_000
const DEFAULT_BT_CLASSIC_TIMEOUT_MS = 1_000
const DEFAULT_PAIRING_ROUTE = "/pairing/loading"
const LOG_TAG = "PairingTimeoutReport"

function projectReadiness() {
  const s = useGlassesStore.getState()
  return {
    state: s.connection.state,
    connected: s.connection.state === "connected",
    fullyBooted: isGlassesReady(s.connection),
    bluetoothClassicConnected: s.bluetoothClassicConnected,
    nativeLinkBusy: isGlassesLinkLayerBusy(s.connection),
  }
}

export type PairingReadinessSnapshot = ReturnType<typeof projectReadiness>

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

async function waitForBluetoothClassic(
  options: Pick<PairingReadyWaitOptions, "timeoutMs" | "signal"> = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BT_CLASSIC_TIMEOUT_MS
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve(false)
      return
    }

    const initial = useGlassesStore.getState().bluetoothClassicConnected
    if (initial) {
      resolve(true)
      return
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: (() => void) | null = null
    let onAbort: (() => void) | null = null

    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (unsubscribe) unsubscribe()
      if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort)
      resolve(value)
    }

    if (options.signal) {
      onAbort = () => finish(false)
      options.signal.addEventListener("abort", onAbort)
    }

    unsubscribe = useGlassesStore.subscribe(
      (s) => s.bluetoothClassicConnected,
      (connected) => {
        if (connected) finish(true)
      },
    )

    timeout = setTimeout(() => {
      finish(useGlassesStore.getState().bluetoothClassicConnected)
    }, timeoutMs)
  })
}

export const pairing = {
  readiness: (): PairingReadinessSnapshot => projectReadiness(),
  onReadiness: (cb: (readiness: PairingReadinessSnapshot) => void): (() => void) => {
    let last = JSON.stringify(projectReadiness())
    return useGlassesStore.subscribe(() => {
      const snap = projectReadiness()
      const key = JSON.stringify(snap)
      if (key === last) return
      last = key
      cb(snap)
    })
  },

  // --- pairing-identity lifecycle (the PairingIdentity read-model + the JS-owned
  // identity writes; promotion to `paired` only ever happens natively) ---
  /** The identity lifecycle snapshot: none | pending (chosen, never paired) | paired. */
  identity: (): IdentitySnapshot => projectPairingIdentity(),
  /** Subscribe to identity changes; fires only when the projected snapshot changes.
   * Returns an unsubscribe. */
  onIdentity: (cb: (identity: IdentitySnapshot) => void): (() => void) => subscribePairingIdentity(cb),
  /** Mark the chosen model as the pending selection (the scan-entry write); the
   * host renders it as a finish-pairing affordance until pairing succeeds. */
  markPendingSelection: (model: string) => markPendingSelection(model),

  /** Start scanning for nearby glasses. Results land on `searchResults()`/`onFound()`. */
  scan: (model: DeviceModel): Promise<void> => BluetoothSdk.startScan(model),
  /** Whether a scan is currently in progress. */
  scanning: (): boolean => useCoreStore.getState().searching,
  /** Subscribe to scan-in-progress changes; fires only when it changes. Returns an unsubscribe. */
  onScanning: (cb: (scanning: boolean) => void): (() => void) => useCoreStore.subscribe((s) => s.searching, cb),
  /** Whether a controller scan is currently in progress. */
  scanningController: (): boolean => useCoreStore.getState().searchingController,
  /** Subscribe to controller-scan-in-progress changes; fires only when it changes. Returns an unsubscribe. */
  onScanningController: (cb: (scanning: boolean) => void): (() => void) =>
    useCoreStore.subscribe((s) => s.searchingController, cb),
  /** Whether the phone has another Bluetooth (audio) device connected — the BT Classic pairing hint. */
  otherBtConnected: (): boolean => useCoreStore.getState().otherBtConnected,
  /** Subscribe to other-Bluetooth-device-connected changes; fires only when it changes. Returns an unsubscribe. */
  onOtherBtConnected: (cb: (connected: boolean) => void): (() => void) =>
    useCoreStore.subscribe((s) => s.otherBtConnected, cb),
  /** The current scan results (snapshot). */
  // Copy the array AND each entry: neither the list nor the Device objects may
  // leak as mutable references into the store.
  searchResults: () => useCoreStore.getState().searchResults.map((result) => ({...result})),
  /** Subscribe to scan-result changes; fires only when they change. Returns an unsubscribe. */
  onFound: (cb: (results: Device[]) => void): (() => void) => {
    let last = JSON.stringify(useCoreStore.getState().searchResults)
    return useCoreStore.subscribe(() => {
      const results = useCoreStore.getState().searchResults
      const key = JSON.stringify(results)
      if (key === last) return
      last = key
      // Copy like searchResults(): listeners must not mutate shared scan state.
      cb(results.map((result) => ({...result})))
    })
  },

  /**
   * Pair with (connect to) a discovered device. Two-phase identity: the connect
   * attempt only marks the device as pending (`saveAsDefault: false` — no eager
   * default-device write); the native layer promotes it to the default wearable
   * when pairing actually succeeds (handleDeviceReady), so an abandoned or
   * failed attempt can't leave a default identity with no paired device behind.
   */
  pair: async (device: Device, options?: ConnectOptions): Promise<void> => {
    await pushAllBluetoothSettings()
    return BluetoothSdk.connect(device, {...options, saveAsDefault: false})
  },
  /** Set a device as the default for subsequent `glasses.connectDefault()`. */
  setDefault: (device: Device | null): Promise<void> => BluetoothSdk.setDefaultDevice(device),
  /**
   * Prime the native Bluetooth Classic audio watcher with the picked device.
   * The iOS Mentra Live flow pairs Classic audio BEFORE any BLE connect
   * exists, and native detects the pairing by matching the connected audio
   * route against its device_name — which two-phase identity no longer sets
   * at selection time. This is native-only routing state (device_name has no
   * native→JS echo): the phone's persisted identity is untouched, and
   * promotion still happens only at pairing success.
   */
  setBluetoothClassicTarget: (device: Device): Promise<void> =>
    BluetoothSdk.updateBluetoothSettings({device_name: device.name}),
  /**
   * Abandon an in-flight pairing attempt (back-out, failure retry, conflict
   * retry) without destroying an existing pairing. The decision comes from the
   * LIVE hydrated default-device read — never from flow-entry state, because a
   * pairing can PROMOTE while the flow is open (the glasses finish pairing
   * even as the user backs out of the UI), and an entry snapshot would forget
   * that brand-new pairing:
   * - Default device exists and glasses are connected (nothing in flight — an
   *   attempt drops the link first): stop the scan, touch nothing else.
   * - Default device exists with an attempt in flight: cancel it, then re-seed
   *   the native identity from the phone's persisted settings — the attempt's
   *   connect-by-name overwrote the native device_name, so a later
   *   connectDefault() would otherwise target the abandoned device.
   * - No default device (genuinely unpaired attempt): also forget, clearing
   *   the partial native pairing state.
   * The read fails OPEN to "preserve" — a transient failure must never wipe a
   * real pairing. The `pending_wearable` marker is deliberately left alone —
   * the host renders it as a finish-pairing affordance.
   */
  abandonAttempt: async (): Promise<void> => {
    const nativeHasDefault = await hasDefaultDevice().catch(() => true)
    if (nativeHasDefault && isGlassesConnected(useGlassesStore.getState().connection)) {
      // Still connected means no connect attempt is in flight (an attempt drops
      // the existing link first): the user browsed the scan and backed out.
      // Stop the scan and leave the live pairing untouched.
      console.log("PairingIdentity: abandonAttempt — pairing intact and connected; stopping scan only")
      await BluetoothSdk.stopScan()
      return
    }
    if (projectPairingIdentity().kind === "paired") {
      // The persisted settings describe a COMPLETE pairing: restore it to
      // native (the attempt's connect-by-name overwrote the native
      // device_name; and if native somehow lost its default entirely, this
      // repairs the divergence instead of forgetting a real pairing).
      console.log("PairingIdentity: abandonAttempt — preserving pairing; attempt cancelled, native identity re-seeded")
      await BluetoothSdk.disconnect()
      await pushAllBluetoothSettings()
      return
    }
    if (nativeHasDefault) {
      // Mid-relay: native promoted and its echoes are still landing — the
      // incomplete JS snapshot must not be pushed over the fresher native
      // identity (the on-connect replay's race). Native holds the truth.
      console.log("PairingIdentity: abandonAttempt — preserving pairing; JS identity mid-relay, native kept as-is")
      await BluetoothSdk.disconnect()
      return
    }
    // Partial attempt: forget owns teardown. Do NOT disconnect() first — that
    // nulls the MentraLive SGC and used to skip Classic removeBond, leaving
    // IBRT ACL up so glasses never re-advertise for the next scan.
    console.log("PairingIdentity: abandonAttempt — no pairing on either layer; forgetting the partial attempt")
    await BluetoothSdk.forget()
  },

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
  /** Wait for paired glasses to finish booting; engine files the timeout diagnostic. */
  waitForReady: waitForReadyDuringPairing,
  /** Wait briefly for Bluetooth Classic to come up after BLE pairing. */
  waitForBluetoothClassic,
}
