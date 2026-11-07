import type {Device, ScanDiagnostic} from "@mentra/bluetooth-sdk"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {AppState, Linking, Platform} from "react-native"

import {glasses} from "../facades/glasses"
import {pairing} from "../facades/pairing"
import {startGlassesStatusProjection} from "../services/GlassesStatusProjection"
import {startPairingProjection} from "../services/PairingProjection"
import {DeviceTypes} from "../types"
import {useEngineSnapshot} from "./useEngineSnapshot"

/**
 * The pages of Mentra Live pairing, in the order a person meets them. Pairing is one 2-minute
 * window on the glasses, and this flow only renders it: the Bluetooth SDK sends `pair_select` on its
 * own, decides when the selected glasses are ready (on secure firmware, only once they commit the new
 * bond), and says whether audio needs the person (`audioSetup`). A previous phone stays paired until
 * the new bond commits on the glasses.
 */
export type MentraLivePairingPage =
  | "prep"
  | "scan"
  | "connecting"
  | "pair_audio"
  | "forget_ios_pairing"
  | "success"
  | "failure"

/**
 * Where the flow starts. `pair_audio` and `forget_ios_pairing` also stand alone, outside an attempt:
 * Pair Audio for glasses that are already paired, and "Forget the old pairing" after an unpair on
 * iOS. Both then leave through `onFinished` (Pair Audio) or `onExit` (forget).
 */
export type MentraLivePairingEntryPage = "prep" | "scan" | "pair_audio" | "forget_ios_pairing"

/** `choosing` lists glasses; `in_use` means matching glasses are already connected to this phone. */
export type MentraLivePairingScanStatus = "searching" | "choosing" | "not_found" | "in_use"

export type MentraLivePairingGlasses = {
  id: string
  /** The Bluetooth name without its model prefix, for example `E511`. */
  label: string
  device: Device
}

export type MentraLivePairingState =
  | {page: "prep"}
  | {
      page: "scan"
      status: MentraLivePairingScanStatus
      /** False once the scan gave up; the list, if any, stays. */
      scanning: boolean
      /** Only glasses that can pair now: in pairing mode, or older firmware that always pairs. */
      glasses: MentraLivePairingGlasses[]
    }
  | {page: "connecting"; device: Device; booting: boolean}
  | {
      page: "pair_audio"
      deviceName: string
      /** True during an attempt: leaving cancels the pairing and unpairs the glasses. */
      canCancel: boolean
      /** Another Bluetooth audio device is connected, so the system's audio picker can help. */
      otherAudioConnected: boolean
    }
  | {page: "forget_ios_pairing"; deviceName: string}
  | {page: "success"}
  | {page: "failure"; error: string}

export type MentraLivePairingController = {
  state: MentraLivePairingState
  /** Prep: the glasses are on; check permissions and open the scan. */
  continueToScan: () => void
  /** Scan: start over, forgetting the list. */
  scanAgain: () => void
  /** Scan: pair these glasses. */
  select: (glasses: MentraLivePairingGlasses) => void
  /** The page's back action. Pair Audio, success and failure have none: they use their own buttons. */
  back: () => void
  /** Pair Audio during an attempt: cancel the pairing, which unpairs the glasses. False if it failed. */
  cancelPairing: () => Promise<boolean>
  /** Pair Audio and "Forget the old pairing": open the phone's Bluetooth settings. */
  openBluetoothSettings: () => void
  /** Success: leave the flow. */
  finish: () => void
  /** Failure: try again. */
  retry: () => void
  /** Failure: leave the flow. */
  exit: () => void
}

export type UseMentraLivePairingOptions = {
  initialPage?: MentraLivePairingEntryPage
  /** Bluetooth name of the glasses for a standalone `pair_audio` or `forget_ios_pairing` entry. */
  deviceName?: string
  /** Start the Engine's glasses status projection. Full Engine hosts should pass false. */
  initializeRuntime?: boolean
  /**
   * The person left the flow from this page: back from prep or scan, Go Home after a failure, a
   * cancelled Pair Audio, or the end of a standalone forget or Pair Audio without saved glasses.
   */
  onExit: (from: MentraLivePairingPage) => void
  /** The glasses are paired and the person continued, or standalone Pair Audio finished. */
  onFinished: () => void
  /** Failure's Try Again. Defaults to scanning again. */
  onRetry?: () => void
  /** Before the scan opens from prep: ask for permissions. False keeps the person on prep. */
  prepareScan?: () => Promise<boolean>
  /** Before connecting to chosen glasses (Android's location permission). False keeps the list. */
  prepareConnect?: () => Promise<boolean>
  /** Opens the phone's Bluetooth settings. Defaults to the app's settings page. */
  openBluetoothSettings?: () => Promise<unknown> | void
  /** Unpairs the paired glasses when the person cancels from Pair Audio. Defaults to `engine.glasses.unpair()`. */
  unpair?: () => Promise<void>
}

const MODEL = DeviceTypes.LIVE
const SCAN_TIMEOUT_MS = 15_000
/** Shorter than the native scan's one minute, so the list never goes stale while it's shown. */
const RESCAN_INTERVAL_MS = 45_000
/** A rescan empties the native list; the rows shown before it stay this long, until glasses advertise again. */
const RESCAN_GRACE_MS = 5_000
const KICKOFF_DELAY_MS = 2_000
const READY_TIMEOUT_MS = 35_000
const SUCCESS_DELAY_MS = 1_000
const COULD_NOT_START = "errors:pairingCouldNotStart"
/** `pair_failure.code` when iOS holds a stale Bluetooth pairing for the glasses: the person removes it in Settings. */
const IOS_FORGET_PAIRING_CODE = "ios_forget_pairing"
/** Bonded glasses already tried since the app started: if they refuse, the person pairs them from the list. */
const triedBondedGlasses = new Set<string>()

const glassesLabel = (name: string) =>
  name
    .replace("MENTRA_LIVE_BLE_", "")
    .replace("MENTRA_LIVE_BT_", "")
    .replace("Mentra_Live_", "")
    .replace("MENTRA_LIVE_", "")

/** The per-attempt latches. A fresh object per attempt, so a stale callback can only touch its own. */
type Attempt = {
  device: Device
  stopped: boolean
  navigated: boolean
  kickoffStarted: boolean
  pairAudioOpened: boolean
  successTimer: ReturnType<typeof setTimeout> | null
}

export function useMentraLivePairing(options: UseMentraLivePairingOptions): MentraLivePairingController {
  const {initialPage = "scan", deviceName: entryDeviceName = "", initializeRuntime = true} = options
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [page, setPage] = useState<MentraLivePairingPage>(initialPage)
  const [runtimeReady, setRuntimeReady] = useState(!initializeRuntime)

  useEffect(() => {
    if (!initializeRuntime) return
    let cancelled = false
    // Without engine.start(), nothing else relays the identity echo or audio setup that readiness reads.
    startPairingProjection()
    void startGlassesStatusProjection().finally(() => {
      if (!cancelled) setRuntimeReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [initializeRuntime])

  // --- scan ---
  const searchResults = useEngineSnapshot(pairing.searchResults, pairing.onFound)
  // Rows shown when a rescan emptied the native list, kept until glasses advertise again or the grace ends.
  const [carried, setCarried] = useState<Device[]>([])
  const [scanTimedOut, setScanTimedOut] = useState(false)
  const [diagnostic, setDiagnostic] = useState<ScanDiagnostic | null>(null)
  const [scanGeneration, setScanGeneration] = useState(0)
  const scanGenerationRef = useRef(0)
  const scanStartedRef = useRef(false)
  const scanOnReturnRef = useRef(false)
  const backedOutRef = useRef(false)
  // A tap latches this so a double tap cannot start two pairings; returning to the list clears it.
  const connectingRef = useRef(false)

  // --- attempt ---
  const attemptRef = useRef<Attempt | null>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [booting, setBooting] = useState(false)
  const [kickoffComplete, setKickoffComplete] = useState(false)
  const [targetReady, setTargetReady] = useState(false)
  const [failureError, setFailureError] = useState(COULD_NOT_START)
  const [forgetName, setForgetName] = useState(entryDeviceName)
  const {audioSetup} = useEngineSnapshot(pairing.readiness, pairing.onReadiness)
  const otherAudioConnected = useEngineSnapshot(pairing.otherBtConnected, pairing.onOtherBtConnected)

  const startScan = useCallback(async () => {
    const generation = scanGenerationRef.current + 1
    scanGenerationRef.current = generation
    setScanGeneration(generation)
    scanStartedRef.current = true
    backedOutRef.current = false
    connectingRef.current = false
    setScanTimedOut(false)
    setDiagnostic(null)
    setCarried([])
    try {
      // A bond means the glasses were never unpaired, so they need no pairing mode and no choosing.
      // Discovery waits for this: it drops their Classic link, which an owner's reconnect keeps.
      const bonded = pairing.identity().kind !== "paired" ? await pairing.bondedGlasses() : null
      if (generation !== scanGenerationRef.current) return
      if (bonded && !triedBondedGlasses.has(bonded.name)) {
        triedBondedGlasses.add(bonded.name)
        scanOnReturnRef.current = true
        selectDeviceRef.current(bonded)
        return
      }
      await pairing.scan(MODEL)
    } catch (error) {
      if (generation === scanGenerationRef.current) console.error("Failed to start glasses scan:", error)
    }
  }, [])

  // Reaching the scan marks Mentra Live as the PENDING selection: Home offers to finish pairing
  // until the native layer promotes it on success.
  useEffect(() => {
    if (page !== "scan" || !runtimeReady || scanStartedRef.current) return
    pairing.markPendingSelection(MODEL)
    void startScan()
  }, [page, runtimeReady, startScan])

  // Invalidate an in-flight bond lookup when the flow goes away.
  useEffect(
    () => () => {
      scanGenerationRef.current += 1
    },
    [],
  )

  // The native list drops glasses whose pairing window closed, so apart from carried rows it is the list.
  const visible = useMemo(() => {
    const found = searchResults.filter((result) => result.model === MODEL && result.name !== "NOTREQUIREDSKIP")
    const kept = carried.map((row) => found.find((result) => result.id === row.id) ?? row)
    return [...kept, ...found.filter((result) => !carried.some((row) => row.id === result.id))]
  }, [searchResults, carried])
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  useEffect(() => {
    if (carried.length === 0) return
    const timer = setTimeout(() => setCarried([]), RESCAN_GRACE_MS)
    return () => clearTimeout(timer)
  }, [carried])
  const visibleCountRef = useRef(visible.length)
  visibleCountRef.current = visible.length

  useEffect(() => {
    if (visible.length > 0) setDiagnostic(null)
  }, [visible.length])

  // The native scan ends after a minute. While glasses are listed, scan again before then, so glasses
  // whose window closes leave the list and someone who presses their button later still appears.
  const listsGlasses = visible.length > 0
  useEffect(() => {
    if (page !== "scan" || scanTimedOut || !listsGlasses) return
    const timer = setInterval(() => {
      if (connectingRef.current) return
      setCarried(visibleRef.current)
      void Promise.resolve(pairing.scan(MODEL)).catch((error) => console.warn("Failed to rescan for glasses:", error))
    }, RESCAN_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [page, scanTimedOut, listsGlasses])

  // Keep scanning while the person chooses, so newly discovered units still appear.
  useEffect(() => {
    if (page !== "scan" || scanTimedOut || listsGlasses) return
    const generation = scanGeneration
    const timer = setTimeout(() => {
      if (generation !== scanGenerationRef.current || connectingRef.current) return
      setScanTimedOut(true)
      void pairing.stopScan()
      void pairing.diagnoseEmptyScan(MODEL).then((result) => {
        if (generation === scanGenerationRef.current && !connectingRef.current && visibleCountRef.current === 0) {
          setDiagnostic(result)
        }
      })
    }, SCAN_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [page, scanGeneration, scanTimedOut, listsGlasses])

  const selectDevice = useCallback(async (device: Device) => {
    if (connectingRef.current) return
    connectingRef.current = true
    setDiagnostic(null)
    const prepareConnect = optionsRef.current.prepareConnect
    if (prepareConnect && !(await prepareConnect())) {
      // Keep the list available for an explicit retry after permissions change.
      connectingRef.current = false
      setScanTimedOut(true)
      void pairing.stopScan()
      return
    }
    const next: Attempt = {
      device,
      stopped: false,
      navigated: false,
      kickoffStarted: false,
      pairAudioOpened: false,
      successTimer: null,
    }
    attemptRef.current = next
    setAttempt(next)
    setBooting(false)
    setKickoffComplete(false)
    setTargetReady(false)
    setPage("connecting")
  }, [])
  const selectDeviceRef = useRef(selectDevice)
  selectDeviceRef.current = selectDevice

  const returnToScan = useCallback(() => {
    setPage("scan")
    connectingRef.current = false
    if (!scanOnReturnRef.current) return
    scanOnReturnRef.current = false
    void startScan()
  }, [startScan])

  /** Ends the attempt. Its listeners stop, and nothing it scheduled can still navigate. */
  const stopAttempt = useCallback((current: Attempt) => {
    current.stopped = true
    current.navigated = true
    if (current.successTimer) clearTimeout(current.successTimer)
    current.successTimer = null
    if (attemptRef.current === current) attemptRef.current = null
    setAttempt((shown) => (shown === current ? null : shown))
  }, [])

  const fail = useCallback(
    (current: Attempt, error: string, code?: string) => {
      // A failure that lands during the one-second success delay wins: it cancels the pending success.
      // A failure after the success page, or after the person left, is ignored.
      if (current.stopped || (current.navigated && !current.successTimer)) return
      console.log(`PAIRFLOW: loading_fail error=${error} name=${current.device.name}`)
      stopAttempt(current)
      void pairing
        .abandonAttempt()
        .catch((cleanupError) => console.warn("Pairing failure cleanup failed:", cleanupError))
      // iPhone holds a stale Bluetooth pairing for these glasses: only this page names them, with the code.
      if (Platform.OS === "ios" && code === IOS_FORGET_PAIRING_CODE) {
        setForgetName(current.device.name)
        setPage("forget_ios_pairing")
        return
      }
      setFailureError(error)
      setPage("failure")
    },
    [stopAttempt],
  )

  useEffect(() => {
    if (!attempt) return
    const target = {deviceModel: attempt.device.model, deviceName: attempt.device.name}
    const observe = (ready: boolean) => {
      setTargetReady(ready)
      if (!ready && attempt.successTimer) {
        clearTimeout(attempt.successTimer)
        attempt.successTimer = null
        if (!attempt.stopped) attempt.navigated = false
      }
    }
    const unsubscribers = [
      pairing.onTargetReady(target, observe),
      pairing.onGlassesNotReady(() => setBooting(true)),
      pairing.onPairFailure((event) => fail(attempt, event.error, event.code)),
    ]
    observe(pairing.targetReady(target))
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [attempt, fail])

  useEffect(() => {
    if (!attempt || page !== "connecting" || attempt.kickoffStarted) return
    const timer = setTimeout(() => {
      if (attempt.stopped) return
      attempt.kickoffStarted = true
      console.log(`PAIRFLOW: loading_kickoff name=${attempt.device.name}`)
      pairing
        .pair(attempt.device)
        .then(() => {
          if (!attempt.stopped) setKickoffComplete(true)
        })
        .catch((error) => {
          console.error("Failed to connect to selected device:", error)
          fail(attempt, COULD_NOT_START)
        })
    }, KICKOFF_DELAY_MS)
    return () => clearTimeout(timer)
  }, [attempt, page, fail])

  useEffect(() => {
    if (!attempt || page !== "connecting" || !kickoffComplete) return
    const controller = new AbortController()
    void pairing
      .waitForReady({
        deviceModel: attempt.device.model,
        deviceName: attempt.device.name,
        timeoutMs: READY_TIMEOUT_MS,
        route: "/pairing/loading",
        signal: controller.signal,
      })
      .then((ready) => {
        if (ready || controller.signal.aborted || attempt.navigated) return
        fail(attempt, COULD_NOT_START)
      })
    return () => controller.abort()
  }, [attempt, page, kickoffComplete, fail])

  useEffect(() => {
    if (!attempt || attempt.stopped || page !== "connecting" || !kickoffComplete || !targetReady) return
    if (attempt.navigated) return
    if (audioSetup.state === "needs_user") {
      // Pair Audio comes back here once the SDK reports audio connected.
      if (attempt.pairAudioOpened) return
      attempt.pairAudioOpened = true
      console.log(`PAIRFLOW: loading_navigate route=/pairing/btclassic name=${attempt.device.name}`)
      setPage("pair_audio")
      return
    }
    // `connecting`: the SDK still expects audio to come up on its own and decides when to stop waiting.
    if (audioSetup.state !== "connected" && audioSetup.state !== "not_applicable") return
    attempt.navigated = true
    console.log(`PAIRFLOW: loading_navigate route=/pairing/success name=${attempt.device.name}`)
    attempt.successTimer = setTimeout(() => {
      attempt.successTimer = null
      setPage("success")
    }, SUCCESS_DELAY_MS)
  }, [attempt, page, kickoffComplete, targetReady, audioSetup.state])

  useEffect(
    () => () => {
      const current = attemptRef.current
      if (current?.successTimer) clearTimeout(current.successTimer)
    },
    [],
  )

  // --- Pair Audio ---
  const audioUp = audioSetup.state === "connected" || audioSetup.state === "not_applicable"
  const pairAudioFinishedRef = useRef(false)

  useEffect(() => {
    if (page !== "pair_audio" || !attempt) return
    // Pair Audio advances when native sees this device's Classic audio route; prime its watcher.
    void pairing.setBluetoothClassicTarget(attempt.device).catch((error) => {
      console.warn("BTCLASSIC: failed to set the Bluetooth Classic target:", error)
    })
  }, [page, attempt])

  useEffect(() => {
    if (page !== "pair_audio" || !audioUp) return
    if (attempt) {
      // The connecting page owns success: it checks readiness again and shows success.
      setPage("connecting")
      return
    }
    if (pairAudioFinishedRef.current) return
    pairAudioFinishedRef.current = true
    glasses.connectDefault().catch((error) => {
      console.error("Failed to connect default glasses after Bluetooth Classic pairing:", error)
    })
    optionsRef.current.onFinished()
  }, [page, audioUp, attempt])

  useEffect(() => {
    if (page !== "pair_audio" || attempt) return
    let cancelled = false
    // Standalone Pair Audio needs saved glasses to reconnect. Fail open on a read error.
    glasses
      .hasDefaultDevice()
      .catch(() => true)
      .then((hasDefault) => {
        if (!cancelled && !hasDefault) optionsRef.current.onExit("pair_audio")
      })
    return () => {
      cancelled = true
    }
  }, [page, attempt])

  // --- forget the old pairing ---
  const forgetLeftRef = useRef(false)
  const leaveForget = useCallback(() => {
    if (forgetLeftRef.current) return
    forgetLeftRef.current = true
    if (initialPage === "forget_ios_pairing") optionsRef.current.onExit("forget_ios_pairing")
    else returnToScan()
  }, [initialPage, returnToScan])

  useEffect(() => {
    if (page !== "forget_ios_pairing") return
    forgetLeftRef.current = false
    // Coming back from Settings (or the app switcher) means the person is done forgetting the glasses.
    let previous = AppState.currentState
    const subscription = AppState.addEventListener("change", (next) => {
      const cameBack = previous !== "active" && next === "active"
      previous = next
      if (cameBack) leaveForget()
    })
    return () => subscription.remove()
  }, [page, leaveForget])

  // --- actions ---
  const backOutOfScan = useCallback(() => {
    if (backedOutRef.current) return
    backedOutRef.current = true
    scanGenerationRef.current += 1
    scanStartedRef.current = false
    setDiagnostic(null)
    // Non-destructive: abandonAttempt decides from the live default-device read, so a re-pair's
    // existing pairing survives, and so does a pairing that promoted while the flow was open. Backing
    // out is the person choosing not to pair now, so the pending marker goes too.
    void pairing
      .abandonAttempt({clearPendingSelection: true})
      .catch(() => pairing.abandonAttempt())
      .catch((error) => console.warn("Pairing scan back-out cleanup failed:", error))
    if (initialPage === "prep") setPage("prep")
    else optionsRef.current.onExit("scan")
  }, [initialPage])

  const cancelConnecting = useCallback(() => {
    const current = attemptRef.current
    if (!current) return
    console.log(`PAIRFLOW: loading_cancel name=${current.device.name}`)
    stopAttempt(current)
    void pairing.abandonAttempt().catch((error) => console.warn("Pairing cancellation cleanup failed:", error))
    returnToScan()
  }, [returnToScan, stopAttempt])

  const continueToScan = useCallback(async () => {
    const prepareScan = optionsRef.current.prepareScan
    if (prepareScan && !(await prepareScan())) return
    setPage("scan")
  }, [])

  const cancelPairing = useCallback(async () => {
    const current = attemptRef.current
    if (!current) return false
    try {
      // By now the glasses are usually paired, so cancelling unpairs them (they forget this phone too).
      // An attempt that never paired them is only abandoned, and an earlier pairing is never unpaired.
      const identity = pairing.identity()
      if (identity.kind === "paired" && identity.name === current.device.name) {
        await (optionsRef.current.unpair ?? glasses.unpair)()
      } else {
        await pairing.abandonAttempt({clearPendingSelection: true})
      }
    } catch (error) {
      console.warn("Failed to cancel pairing from Pair Audio:", error)
      return false
    }
    stopAttempt(current)
    optionsRef.current.onExit("pair_audio")
    return true
  }, [stopAttempt])

  const openBluetoothSettings = useCallback(() => {
    const open = optionsRef.current.openBluetoothSettings
    if (open) {
      void Promise.resolve(open()).catch((error) => console.error("Failed to open Bluetooth settings", error))
      return
    }
    void Linking.openSettings()
  }, [])

  const retry = useCallback(() => {
    // Clears the failed attempt; a pre-existing pairing (re-pair) is preserved.
    void pairing.abandonAttempt().catch((error) => console.warn("Pairing retry cleanup failed:", error))
    const onRetry = optionsRef.current.onRetry
    if (onRetry) {
      onRetry()
      return
    }
    setPage("scan")
    void startScan()
  }, [startScan])

  const back = useCallback(() => {
    switch (page) {
      case "prep":
        optionsRef.current.onExit("prep")
        return
      case "scan":
        backOutOfScan()
        return
      case "connecting":
        cancelConnecting()
        return
      case "forget_ios_pairing":
        leaveForget()
        return
      case "failure":
        optionsRef.current.onExit("failure")
        return
      case "pair_audio":
      case "success":
        return
    }
  }, [page, backOutOfScan, cancelConnecting, leaveForget])

  const state = useMemo((): MentraLivePairingState => {
    switch (page) {
      case "prep":
      case "success":
        return {page}
      case "scan": {
        const listed = visible.map((device) => ({id: device.id, label: glassesLabel(device.name), device}))
        const status: MentraLivePairingScanStatus =
          diagnostic?.code === "device_connected_on_phone" && listed.length === 0
            ? "in_use"
            : listed.length > 0
              ? "choosing"
              : scanTimedOut
                ? "not_found"
                : "searching"
        return {
          page,
          status,
          scanning: !scanTimedOut,
          glasses: listed,
        }
      }
      case "connecting":
        return attempt
          ? {page, device: attempt.device, booting}
          : {page: "scan", status: "searching", scanning: true, glasses: []}
      case "pair_audio":
        return {
          page,
          deviceName: attempt?.device.name || entryDeviceName,
          canCancel: !!attempt,
          otherAudioConnected,
        }
      case "forget_ios_pairing":
        return {page, deviceName: forgetName}
      case "failure":
        return {page, error: failureError}
    }
  }, [
    page,
    visible,
    diagnostic,
    scanTimedOut,
    attempt,
    booting,
    entryDeviceName,
    otherAudioConnected,
    forgetName,
    failureError,
  ])

  return {
    state,
    continueToScan: () => void continueToScan(),
    scanAgain: () => {
      // Stop first so iOS forgets the prior allowDuplicates=false result after pairing mode changes.
      void Promise.resolve(pairing.stopScan()).finally(() => void startScan())
    },
    select: (item) => void selectDevice(item.device),
    back,
    cancelPairing,
    openBluetoothSettings,
    finish: () => optionsRef.current.onFinished(),
    retry,
    exit: () => optionsRef.current.onExit("failure"),
  }
}
