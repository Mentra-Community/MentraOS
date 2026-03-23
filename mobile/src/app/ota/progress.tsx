import CoreModule from "core"
import {useEffect, useState, useRef, useCallback} from "react"
import {View, ActivityIndicator} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import {Screen, Header, Button, Text, Icon} from "@/components/ignite"
import {LoadingCoverVideo} from "@/components/ota/LoadingCoverVideo"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {checkBesUpdate, findMatchingMtkPatch, fetchVersionInfo, OTA_VERSION_URL_PROD} from "@/effects/OtaUpdateChecker"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {logEvent} from "@/utils/analytics"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

type ProgressState =
  | "starting"
  | "downloading"
  | "installing"
  | "completed"
  | "failed"
  | "disconnected"
  | "restarting"
  | "wifi_disconnected"

type OtaButtonId = "continue" | "retry" | "skip_super" | "try_again" | "change_wifi"

type OtaButtonState = {
  id: OtaButtonId
  enabled: boolean
}

const MAX_RETRIES = 3
const RETRY_INTERVAL_MS = 5000 // 5 seconds between retries
const PROGRESS_TIMEOUT_MS = 120000 // 120 seconds - for APK/BES updates with regular progress
const DOWNLOAD_STUCK_TIMEOUT_MS = 70000
const MTK_INSTALL_TIMEOUT_MS = 300000 // 5 minutes - MTK system install takes much longer with no progress updates
// Whole-session cap: if no terminal state (completed/failed/etc.) within this time, fail the OTA.
const GLOBAL_OTA_TIMEOUT_MS = 20 * 60 * 1000 // 20 minutes
// Delay between APK install completion (glasses reconnected) and sending the next ota_start.
// The new APK's OTA service needs a moment to fully initialize after the app restarts.
const POST_APK_OTA_START_DELAY_MS = 6000
const OTA_COVER_VIDEO_URL = "https://mentra-videos-cdn.mentraglass.com/onboarding/ota/ota_video_2.mp4"

export default function OtaProgressScreen() {
  const {theme} = useAppTheme()
  const {replace, push} = useNavigationHistory()
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const otaProgress = useGlassesStore((state) => state.otaProgress)
  const otaUpdateAvailable = useGlassesStore((state) => state.otaUpdateAvailable)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const wifiConnected = useGlassesStore((state) => state.wifiConnected)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  const besFwVersion = useGlassesStore((state) => state.besFwVersion)
  const mtkFwVersion = useGlassesStore((state) => state.mtkFwVersion)

  const [progressState, setProgressState] = useState<ProgressState>("starting")
  const [retryCount, setRetryCount] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [continueButtonDisabled, setContinueButtonDisabled] = useState(false)
  const [elapsedTime, setElapsedTime] = useState<string>("")

  // Track the full update sequence and current position.
  // Set sequence once from otaUpdateAvailable so we show "Update X of 3" for the whole session.
  // Do not overwrite when glasses later send ota_update_available with fewer items (e.g. [mtk, bes] after APK).
  const updateSequenceRef = useRef<string[]>([])
  if (otaUpdateAvailable?.updates?.length && updateSequenceRef.current.length === 0) {
    updateSequenceRef.current = [...otaUpdateAvailable.updates]
  }
  const [currentUpdateIndex, setCurrentUpdateIndex] = useState(0)
  const [completedUpdates, setCompletedUpdates] = useState<string[]>([])

  // DEBUG: Log otaProgress changes
  useEffect(() => {
    console.log("🔍 OTA DEBUG: otaProgress changed:", JSON.stringify(otaProgress, null, 2))
    console.log("🔍 OTA DEBUG: progressState:", progressState)
    console.log("🔍 OTA DEBUG: glassesConnected:", glassesConnected)
    console.log("🔍 OTA DEBUG: currentUpdateIndex:", currentUpdateIndex, "of", updateSequenceRef.current.length)
  }, [otaProgress, progressState, glassesConnected, currentUpdateIndex])

  // Track if we've received any progress from glasses
  const hasReceivedProgress = useRef(false)
  // Track if the glasses acknowledged receipt of ota_start (fires before any progress event)
  const hasReceivedAck = useRef(false)
  // Skip the first otaProgress processing on mount to avoid acting on stale state
  // from a previous autonomous OTA cycle (the mount effect clears it, but fires
  // in the same render cycle as the processing effect)
  const skipStaleProgressRef = useRef(true)
  const latestOtaProgressRef = useRef(otaProgress)
  const retryTimeoutRef = useRef<number | null>(null)
  const stuckTimeoutRef = useRef<number | null>(null)
  const progressTimeoutRef = useRef<number | null>(null)
  // Global OTA session timeout: fail if we don't reach a terminal state within GLOBAL_OTA_TIMEOUT_MS
  const globalTimeoutRef = useRef<number | null>(null)
  // Post-APK settle delay: cleared if we unmount or disconnect before it fires
  const postReconnectDelayRef = useRef<number | null>(null)
  // Gates sendOtaStartCommand between steps — set true when waiting for glasses to reconnect
  const waitingForReconnectRef = useRef(false)
  // When user remounts mid-sequence (e.g. after MTK, before BES), we need to send ota_start.
  const hasSentOtaStartMidSequenceRef = useRef(false)

  useEffect(() => {
    latestOtaProgressRef.current = otaProgress
  }, [otaProgress])

  // Reset ack/progress refs on mount so each new OTA session (e.g. user tapped Update again
  // after a completed run) can receive ota_start_ack and cancel the retry timer. Without this,
  // a second run would keep hasReceivedAck.current === true from the previous run and ignore
  // the new ack, leading to "max_retries_no_ack" and "Unable to start update".
  useEffect(() => {
    hasReceivedAck.current = false
    hasReceivedProgress.current = false
  }, [])

  // Track initial build number to detect successful install
  const initialBuildNumber = useRef<string | null>(null)
  // Track which update type the build number was captured for
  const buildNumberCapturedForUpdate = useRef<string | null>(null)

  // Track which updates have finished downloading (for aggregate download progress)
  const downloadedUpdatesRef = useRef<Set<string>>(new Set())

  // Track if we're doing a firmware update (persists across reconnection for ConnectionOverlay)
  const wasFirmwareUpdateRef = useRef(false)

  // Cover video state - only show once per OTA session
  const [showCoverVideo, setShowCoverVideo] = useState(false)
  const hasShownVideoRef = useRef(false)
  const sawDisconnectDuringRestartRef = useRef(false)
  const progressStateRef = useRef<ProgressState>(progressState)
  const lastProcessedProgressSignatureRef = useRef<string | null>(null)
  const lastTrackedPhaseSignatureRef = useRef<string | null>(null)
  const lastTrackedButtonSignatureRef = useRef<string | null>(null)

  // Progress simulation for MTK install stall (typically stalls around 49-50%)
  // Uses timeout-based stall detection: when no real progress for 20s in the 45-55% zone,
  // start incrementing by 1% every 15s to keep user informed (caps at 60%)
  const [simulatedProgress, setSimulatedProgress] = useState<number | null>(null)
  const simulationTimerRef = useRef<number | null>(null)
  const stallDetectionRef = useRef<number | null>(null)
  const lastRealProgressRef = useRef<number>(0)
  const [otaStartTime, setOtaStartTime] = useState<number>(0)
  const pingIntervalRef = useRef<number | null>(null)

  const trackOtaEvent = useCallback(
    (eventName: string, params: Record<string, string | number | boolean | null | undefined>) => {
      const normalizedParams: Record<string, string | number | boolean> = {}
      Object.entries(params).forEach(([key, value]) => {
        if (value === null || value === undefined) return
        normalizedParams[key] = value
      })

      console.log("OTA TRACK:", eventName, JSON.stringify(normalizedParams))
      void logEvent(eventName, normalizedParams).catch((error) => {
        console.log(`OTA TRACK: Failed to log analytics event '${eventName}':`, error)
      })
    },
    [],
  )

  const getVisibleButtonStates = useCallback((): OtaButtonState[] => {
    if (progressState === "restarting") {
      return [{id: "continue", enabled: !continueButtonDisabled}]
    }
    if (progressState === "completed") {
      return [{id: "continue", enabled: true}]
    }
    if (progressState === "disconnected") {
      const states: OtaButtonState[] = [
        {id: "retry", enabled: true},
        {id: "change_wifi", enabled: true},
      ]
      if (superMode) {
        states.push({id: "skip_super", enabled: true})
      }
      return states
    }
    if (progressState === "wifi_disconnected") {
      return [
        {id: "try_again", enabled: true},
        {id: "change_wifi", enabled: true},
      ]
    }
    if (progressState === "failed") {
      return [
        {id: "retry", enabled: true},
        {id: "change_wifi", enabled: true},
      ]
    }
    return []
  }, [continueButtonDisabled, progressState, superMode])

  const trackButtonPress = useCallback(
    (buttonId: OtaButtonId) => {
      trackOtaEvent("ota_progress_button_press", {
        button_id: buttonId,
        phase: progressState,
        update_type: otaProgress?.currentUpdate ?? "none",
        ota_stage: otaProgress?.stage ?? "none",
        ota_status: otaProgress?.status ?? "none",
        step_index: currentUpdateIndex + 1,
        step_total: updateSequenceRef.current.length,
        glasses_connected: glassesConnected,
        wifi_connected: wifiConnected,
      })
    },
    [currentUpdateIndex, glassesConnected, otaProgress, progressState, trackOtaEvent, wifiConnected],
  )

  // Track OTA phase and button-state observability with deduplication.
  useEffect(() => {
    const phasePayload = {
      phase: progressState,
      update_type: otaProgress?.currentUpdate ?? "none",
      ota_stage: otaProgress?.stage ?? "none",
      ota_status: otaProgress?.status ?? "none",
      step_index: currentUpdateIndex + 1,
      step_total: updateSequenceRef.current.length,
      glasses_connected: glassesConnected,
      wifi_connected: wifiConnected,
      has_error: !!errorMessage,
    }
    const phaseSignature = JSON.stringify(phasePayload)
    if (lastTrackedPhaseSignatureRef.current !== phaseSignature) {
      trackOtaEvent("ota_progress_phase_state", phasePayload)
      lastTrackedPhaseSignatureRef.current = phaseSignature
    }

    const buttonStates = getVisibleButtonStates()
    const buttonSignature = JSON.stringify({phase: progressState, buttons: buttonStates})
    if (lastTrackedButtonSignatureRef.current !== buttonSignature) {
      trackOtaEvent("ota_progress_button_panel", {
        phase: progressState,
        visible_button_count: buttonStates.length,
        all_buttons_disabled: buttonStates.length > 0 && buttonStates.every((button) => !button.enabled),
      })

      buttonStates.forEach((button) => {
        trackOtaEvent("ota_progress_button_state", {
          button_id: button.id,
          phase: progressState,
          enabled: button.enabled,
          update_type: otaProgress?.currentUpdate ?? "none",
          step_index: currentUpdateIndex + 1,
          step_total: updateSequenceRef.current.length,
        })
      })

      lastTrackedButtonSignatureRef.current = buttonSignature
    }
  }, [
    currentUpdateIndex,
    errorMessage,
    getVisibleButtonStates,
    glassesConnected,
    otaProgress,
    progressState,
    trackOtaEvent,
    wifiConnected,
  ])

  // Keep glasses awake during OTA by sending periodic pings
  // This prevents the glasses from sleeping during long OTA operations
  useEffect(() => {
    const isOtaActive =
      progressState === "starting" || progressState === "downloading" || progressState === "installing"

    if (isOtaActive && glassesConnected) {
      // Send initial ping immediately
      CoreModule.ping().catch((err) => console.log("OTA: ping failed:", err))

      // Set up interval to ping every 10 seconds
      pingIntervalRef.current = setInterval(() => {
        CoreModule.ping().catch((err) => console.log("OTA: ping failed:", err))
      }, 10000) as unknown as number

      return () => {
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current)
          pingIntervalRef.current = null
        }
      }
    } else {
      // Clear interval if OTA is not active or glasses disconnected
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
        pingIntervalRef.current = null
      }
    }
  }, [progressState, glassesConnected])

  focusEffectPreventBack()

  // Show cover video when update begins (only once per session)
  useEffect(() => {
    progressStateRef.current = progressState
    if ((progressState === "downloading" || progressState === "installing") && !hasShownVideoRef.current) {
      console.log("OTA: Starting cover video")
      hasShownVideoRef.current = true
      setShowCoverVideo(true)
    }
  }, [progressState])

  // Handle cover video close (either finished or user dismissed)
  const handleCoverVideoClosed = useCallback(() => {
    console.log("OTA: Cover video closed")
    setShowCoverVideo(false)
  }, [])

  // Capture the update sequence on mount from otaUpdateAvailable
  useEffect(() => {
    const sequence = otaUpdateAvailable?.updates?.length ? [...otaUpdateAvailable.updates] : []
    if (sequence.length) {
      updateSequenceRef.current = sequence
    }
    console.log(
      "OTA_TRACK: screen_mounted",
      JSON.stringify({
        sequence: [...updateSequenceRef.current],
        otaUpdateAvailable: otaUpdateAvailable ? {updates: otaUpdateAvailable.updates} : null,
        initialOtaProgress: otaProgress ? {currentUpdate: otaProgress.currentUpdate, status: otaProgress.status} : null,
        action: "clearing_otaProgress",
      }),
    )
    useGlassesStore.getState().setOtaProgress(null)
    downloadedUpdatesRef.current = new Set()

    return () => {
      console.log("OTA_TRACK: screen_unmounted", JSON.stringify({sequence: [...updateSequenceRef.current]}))
    }
  }, [])

  // Capture initial build number on mount (only for APK updates)
  useEffect(() => {
    if (buildNumber && !initialBuildNumber.current) {
      initialBuildNumber.current = buildNumber
      // Only mark as captured for APK if APK is in the sequence
      if (updateSequenceRef.current.includes("apk")) {
        buildNumberCapturedForUpdate.current = "apk"
      }
      console.log("OTA: Initial build number:", buildNumber)
    }
  }, [buildNumber])

  // Re-validate update sequence when firmware versions change mid-flow
  // This handles the case where glasses report their actual firmware version after ASG client update,
  // and we discover that some updates in the queue are no longer needed
  useEffect(() => {
    const revalidateUpdateSequence = async () => {
      // Only revalidate if we have pending updates
      if (updateSequenceRef.current.length === 0) return

      // Fetch the latest version.json to check against
      const versionJson = await fetchVersionInfo(OTA_VERSION_URL_PROD)
      if (!versionJson) {
        console.log("OTA REVALIDATE: Could not fetch version.json")
        return
      }

      let sequenceChanged = false
      const originalSequence = [...updateSequenceRef.current]

      // Check if BES update is still needed
      if (updateSequenceRef.current.includes("bes") && besFwVersion) {
        const besStillNeeded = checkBesUpdate(versionJson.bes_firmware, besFwVersion)
        if (!besStillNeeded) {
          console.log(
            `OTA REVALIDATE: BES no longer needs update (current: ${besFwVersion}, server: ${versionJson.bes_firmware?.version})`,
          )
          updateSequenceRef.current = updateSequenceRef.current.filter((u) => u !== "bes")
          sequenceChanged = true
        }
      }

      // Check if MTK update is still needed
      if (updateSequenceRef.current.includes("mtk") && mtkFwVersion) {
        const mtkPatch = findMatchingMtkPatch(versionJson.mtk_patches, mtkFwVersion)
        if (!mtkPatch) {
          console.log(`OTA REVALIDATE: MTK no longer needs update (current: ${mtkFwVersion}, no matching patch)`)
          updateSequenceRef.current = updateSequenceRef.current.filter((u) => u !== "mtk")
          sequenceChanged = true
        }
      }

      if (sequenceChanged) {
        console.log(
          `OTA REVALIDATE: Update sequence changed from [${originalSequence}] to [${updateSequenceRef.current}]`,
        )

        // Update the store as well
        if (otaUpdateAvailable) {
          useGlassesStore.getState().setOtaUpdateAvailable({
            ...otaUpdateAvailable,
            updates: updateSequenceRef.current,
          })
        }

        // If no updates left, mark as completed
        if (updateSequenceRef.current.length === 0) {
          console.log(
            "OTA_TRACK: state_transition",
            JSON.stringify({from: progressState, to: "completed", reason: "revalidate_no_updates_left"}),
          )
          setProgressState("completed")
        } else if (progressState === "starting") {
          if (currentUpdateIndex >= updateSequenceRef.current.length) {
            console.log(
              "OTA_TRACK: state_transition",
              JSON.stringify({
                from: progressState,
                to: "completed",
                reason: "revalidate_no_more_updates",
                currentUpdateIndex,
              }),
            )
            setProgressState("completed")
          }
        }
      }
    }

    revalidateUpdateSequence()
  }, [besFwVersion, mtkFwVersion])

  // Detect successful APK install by watching for build number increase
  // Detect successful APK install by watching for build number increase.
  // Runs in two scenarios:
  //   1. Normal flow: progressState is "installing" and otaProgress.currentUpdate is "apk".
  //   2. Fallback: The glasses sent progress with the wrong currentUpdate label (e.g. "bes"),
  //      so the wrong-step guard dropped it and we never left "starting"/"failed".
  //      If APK is in the sequence and build number bumped, we still detect success.
  useEffect(() => {
    if (!buildNumber || !initialBuildNumber.current) return
    if (buildNumberCapturedForUpdate.current !== "apk") return
    if (!updateSequenceRef.current.includes("apk")) return

    const currentVersion = parseInt(buildNumber, 10)
    const initialVersion = parseInt(initialBuildNumber.current, 10)
    if (isNaN(currentVersion) || isNaN(initialVersion) || currentVersion <= initialVersion) return

    // Normal path: installing + otaProgress confirms apk
    const isNormalApkDetection = progressState === "installing" && otaProgress?.currentUpdate === "apk"
    // Fallback path: still starting/failed but build number proves APK succeeded
    const isFallbackDetection =
      (progressState === "starting" || progressState === "failed") &&
      updateSequenceRef.current[currentUpdateIndex] === "apk"

    if (!isNormalApkDetection && !isFallbackDetection) return

    console.log(
      "OTA_TRACK: apk_complete_via_build_number",
      JSON.stringify({
        initialVersion,
        currentVersion,
        detection: isNormalApkDetection ? "normal" : "fallback",
        sequence: [...updateSequenceRef.current],
        currentUpdateIndex,
        progressState: progressStateRef.current,
      }),
    )
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current)
      progressTimeoutRef.current = null
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    if (stuckTimeoutRef.current) {
      clearTimeout(stuckTimeoutRef.current)
      stuckTimeoutRef.current = null
    }
    handleUpdateCompleted("apk")
  }, [buildNumber, progressState, otaProgress?.currentUpdate])

  // Advance to the next step in the sequence without navigating away.
  // Resets all per-step state and waits for glasses to be ready before sending ota_start.
  const advanceToNextStep = useCallback(
    (completedUpdate: string) => {
      const nextIndex = currentUpdateIndex + 1
      console.log(
        "OTA_TRACK: advance_to_next_step",
        JSON.stringify({
          completedUpdate,
          nextIndex,
          sequence: [...updateSequenceRef.current],
        }),
      )

      // Clear all active timers
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
        progressTimeoutRef.current = null
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
      if (stuckTimeoutRef.current) {
        clearTimeout(stuckTimeoutRef.current)
        stuckTimeoutRef.current = null
      }
      if (postReconnectDelayRef.current) {
        clearTimeout(postReconnectDelayRef.current)
        postReconnectDelayRef.current = null
      }
      // completionTimeoutRef: 12s timer after apk install FINISHED that calls handleUpdateCompleted("apk").
      // Clear to prevent double-fire if buildNumber-change detection already called us first.
      if (completionTimeoutRef.current) {
        clearTimeout(completionTimeoutRef.current)
        completionTimeoutRef.current = null
      }
      // Clear MTK simulation timers
      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current)
        simulationTimerRef.current = null
      }
      if (stallDetectionRef.current) {
        clearTimeout(stallDetectionRef.current)
        stallDetectionRef.current = null
      }

      // Reset per-step tracking state
      hasReceivedProgress.current = false
      hasReceivedAck.current = false
      skipStaleProgressRef.current = false
      lastProcessedProgressSignatureRef.current = null
      setSimulatedProgress(null)
      setRetryCount(0)
      setErrorMessage(null)
      useGlassesStore.getState().setOtaProgress(null)

      // After APK: do NOT clear buildNumber here. Completion is often detected via the same
      // version_info that set buildNumber (e.g. 32→34). Clearing it would make the reconnect
      // effect's readyCondition (glassesConnected && buildNumber) false, so we'd never send
      // ota_start for MTK. We still clear buildNumber in navigateAfterContinue when leaving
      // so check-for-updates can get a fresh version_info.

      // Gate ota_start until glasses are ready (reconnect-watch useEffect clears this)
      waitingForReconnectRef.current = true
      hasSentOtaStartMidSequenceRef.current = false
      setCurrentUpdateIndex(nextIndex)
      setProgressState("starting")
    },
    [currentUpdateIndex],
  )

  // Clear global OTA session timeout (call on terminal state or unmount)
  const clearGlobalTimeout = useCallback(() => {
    if (globalTimeoutRef.current !== null) {
      clearTimeout(globalTimeoutRef.current)
      globalTimeoutRef.current = null
      console.log("OTA_TRACK: global_timeout_cleared")
    }
  }, [])

  // Send OTA start command with retry logic
  const sendOtaStartCommand = useCallback(async () => {
    try {
      console.log(
        "OTA_TRACK: send_ota_start",
        JSON.stringify({attempt: retryCount + 1, maxRetries: MAX_RETRIES, sequence: [...updateSequenceRef.current]}),
      )
      await CoreModule.sendOtaStart()
      setOtaStartTime(Date.now())

      // Start global session timeout once (covers whole multi-step OTA)
      if (globalTimeoutRef.current === null) {
        globalTimeoutRef.current = setTimeout(() => {
          globalTimeoutRef.current = null
          console.log(
            "OTA_TRACK: state_transition",
            JSON.stringify({from: progressStateRef.current, to: "failed", reason: "global_ota_timeout"}),
          )
          if (progressTimeoutRef.current) {
            clearTimeout(progressTimeoutRef.current)
            progressTimeoutRef.current = null
          }
          if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current)
            retryTimeoutRef.current = null
          }
          if (stuckTimeoutRef.current) {
            clearTimeout(stuckTimeoutRef.current)
            stuckTimeoutRef.current = null
          }
          if (postReconnectDelayRef.current) {
            clearTimeout(postReconnectDelayRef.current)
            postReconnectDelayRef.current = null
          }
          if (completionTimeoutRef.current) {
            clearTimeout(completionTimeoutRef.current)
            completionTimeoutRef.current = null
          }
          if (simulationTimerRef.current) {
            clearInterval(simulationTimerRef.current)
            simulationTimerRef.current = null
          }
          if (stallDetectionRef.current) {
            clearTimeout(stallDetectionRef.current)
            stallDetectionRef.current = null
          }
          setErrorMessage("Update took too long. Please try again.")
          setProgressState("failed")
        }, GLOBAL_OTA_TIMEOUT_MS) as unknown as number
        console.log("OTA_TRACK: global_timeout_started", JSON.stringify({ms: GLOBAL_OTA_TIMEOUT_MS}))
      }

      // Set up timeout: retry if glasses don't ack within RETRY_INTERVAL_MS.
      // Ack arrives in milliseconds; progress can take 10–30 s.
      retryTimeoutRef.current = setTimeout(() => {
        if (!hasReceivedAck.current && progressState === "starting") {
          if (retryCount < MAX_RETRIES - 1) {
            console.log("OTA_TRACK: retry", JSON.stringify({reason: "no_ack_received", nextAttempt: retryCount + 2}))
            setRetryCount((prev) => prev + 1)
          } else {
            console.log(
              "OTA_TRACK: state_transition",
              JSON.stringify({from: "starting", to: "failed", reason: "max_retries_no_ack"}),
            )
            setErrorMessage("Unable to start update. Glasses did not respond.")
            setProgressState("failed")
          }
        }
      }, RETRY_INTERVAL_MS) as unknown as number
      // if after 30 seconds we have received progress, but the progress is still 0, (detect if we're stuck at 0%):
      stuckTimeoutRef.current = setTimeout(() => {
        const latestProgress = latestOtaProgressRef.current?.progress ?? 0
        if (latestProgress === 0) {
          // cancel the retry timeout
          if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current)
            retryTimeoutRef.current = null
          }
          console.log(
            "OTA_TRACK: state_transition",
            JSON.stringify({from: progressStateRef.current, to: "failed", reason: "stuck_at_0_percent"}),
          )
          setErrorMessage("Update may have failed. Ensure glasses have internet access and try again.")
          setProgressState("failed")
        }
      }, DOWNLOAD_STUCK_TIMEOUT_MS) as unknown as number
    } catch (error) {
      console.log("OTA_TRACK: send_ota_start_error", JSON.stringify({error: String(error), retryCount}))
      if (retryCount < MAX_RETRIES - 1) {
        setRetryCount((prev) => prev + 1)
      } else {
        console.log(
          "OTA_TRACK: state_transition",
          JSON.stringify({from: "starting", to: "failed", reason: "send_ota_start_failed"}),
        )
        setErrorMessage("Failed to communicate with glasses.")
        setProgressState("failed")
      }
    }
  }, [retryCount, progressState])

  // When waitingForReconnectRef is true, watch for glasses to be ready then trigger ota_start.
  // After APK: requires BLE reconnect AND fresh buildNumber (version_info arrived), then waits
  //            POST_APK_OTA_START_DELAY_MS for the new OTA service to fully initialize.
  // After MTK/BES reboot: requires BLE reconnect only (no delay needed).
  // We call sendOtaStartCommand() directly (not setRetryCount(0)) because retryCount was already
  // reset to 0 in advanceToNextStep, so the effect that sends on retryCount would not re-run.
  useEffect(() => {
    if (!waitingForReconnectRef.current) return
    if (progressState !== "starting") return
    if (currentUpdateIndex === 0) return // initial mount — existing logic handles this

    const prevUpdate = updateSequenceRef.current[currentUpdateIndex - 1]
    const readyCondition = prevUpdate === "apk" ? glassesConnected && !!buildNumber : glassesConnected

    if (!readyCondition) return

    // Cancel any pre-existing delay (e.g. buildNumber changed twice quickly)
    if (postReconnectDelayRef.current) {
      clearTimeout(postReconnectDelayRef.current)
      postReconnectDelayRef.current = null
    }

    const fire = () => {
      postReconnectDelayRef.current = null
      waitingForReconnectRef.current = false
      hasSentOtaStartMidSequenceRef.current = true
      if (prevUpdate === "apk") {
        console.log("OTA: Sending ota_start after APK update successful (post-delay complete)")
      }
      console.log(
        "OTA_TRACK: reconnect_ready",
        JSON.stringify({prevUpdate, currentUpdateIndex, glassesConnected, hasBuildNumber: !!buildNumber}),
      )
      sendOtaStartCommand()
    }

    if (prevUpdate === "apk") {
      console.log(
        "OTA_TRACK: post_apk_delay",
        JSON.stringify({delayMs: POST_APK_OTA_START_DELAY_MS, currentUpdateIndex}),
      )
      postReconnectDelayRef.current = setTimeout(fire, POST_APK_OTA_START_DELAY_MS) as unknown as number
    } else {
      fire()
    }

    return () => {
      if (postReconnectDelayRef.current) {
        clearTimeout(postReconnectDelayRef.current)
        postReconnectDelayRef.current = null
      }
    }
  }, [glassesConnected, buildNumber, progressState, currentUpdateIndex, sendOtaStartCommand])

  // When remounting mid-sequence (e.g. user left after MTK, came back to progress screen),
  // send ota_start so the next step (e.g. BES) starts. Reconnect effect only runs when
  // waitingForReconnectRef is true, which is lost on unmount. Skip when reconnect path will send.
  useEffect(() => {
    if (waitingForReconnectRef.current) return
    if (currentUpdateIndex === 0) return
    if (progressState !== "starting" && progressState !== "installing") return
    if (!glassesConnected) return
    if (hasSentOtaStartMidSequenceRef.current) return
    if (currentUpdateIndex >= updateSequenceRef.current.length) return

    hasSentOtaStartMidSequenceRef.current = true
    console.log(
      "OTA_TRACK: remount_mid_sequence_send_ota_start",
      JSON.stringify({currentUpdateIndex, progressState, nextUpdate: updateSequenceRef.current[currentUpdateIndex]}),
    )
    sendOtaStartCommand()
  }, [currentUpdateIndex, progressState, glassesConnected, sendOtaStartCommand])

  // Handle when an update completes.
  // If more steps remain in the sequence, advance internally (no navigation).
  // If this is the last step, transition to "completed" for the user to tap Continue.
  const handleUpdateCompleted = useCallback(
    (completedUpdate: string) => {
      console.log(
        "OTA_TRACK: handleUpdateCompleted",
        JSON.stringify({
          completedUpdate,
          sequence: [...updateSequenceRef.current],
          progressStateBefore: progressStateRef.current,
        }),
      )

      setCompletedUpdates((prev) => {
        if (prev.includes(completedUpdate)) return prev
        return [...prev, completedUpdate]
      })

      const nextIndex = currentUpdateIndex + 1
      const hasMoreSteps = nextIndex < updateSequenceRef.current.length

      if (hasMoreSteps) {
        console.log(
          "OTA_TRACK: state_transition",
          JSON.stringify({
            from: progressStateRef.current,
            reason: "advance_to_next_step",
            completedUpdate,
            nextIndex,
          }),
        )
        advanceToNextStep(completedUpdate)
      } else {
        console.log(
          "OTA_TRACK: state_transition",
          JSON.stringify({from: progressStateRef.current, to: "completed", reason: "last_step_completed"}),
        )
        setProgressState("completed")
      }
    },
    [currentUpdateIndex, advanceToNextStep],
  )

  useEffect(() => {
    if (!otaStartTime) return

    const interval = setInterval(() => {
      const diff = Date.now() - otaStartTime
      const totalSeconds = Math.floor(diff / 1000)
      const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0")
      const s = String(totalSeconds % 60).padStart(2, "0")
      setElapsedTime(`${m}:${s}`)
    }, 1000)

    return () => clearInterval(interval)
  }, [otaStartTime])

  // Initial send and retry on count change
  useEffect(() => {
    // Don't retry if we've already received progress or completed/failed
    if (hasReceivedProgress.current || progressState !== "starting") return
    // Don't send while waiting for glasses to reconnect after a step transition
    if (waitingForReconnectRef.current) return

    sendOtaStartCommand()

    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
    }
  }, [retryCount, sendOtaStartCommand, progressState])

  // Watch for BLE disconnection
  useEffect(() => {
    // Don't fail on disconnect during certain states - glasses will reboot/power off
    if (
      !glassesConnected &&
      progressState !== "completed" &&
      progressState !== "failed" &&
      progressState !== "installing" &&
      progressState !== "restarting" &&
      progressState !== "disconnected"
    ) {
      console.log("OTA: Glasses disconnected during update")
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
      if (postReconnectDelayRef.current) {
        clearTimeout(postReconnectDelayRef.current)
        postReconnectDelayRef.current = null
      }
      waitingForReconnectRef.current = false
      setErrorMessage("Glasses disconnected during update.")
      setProgressState("disconnected")
    }

    // If we're installing/restarting and disconnect, that's expected for MTK/BES updates
    if (!glassesConnected && (progressState === "installing" || progressState === "restarting")) {
      const updateType = otaProgress?.currentUpdate
      if (updateType === "mtk" || updateType === "bes") {
        console.log(`OTA: Glasses disconnected during ${updateType} update - expected behavior`)
        setProgressState("restarting")
      }
    }
  }, [glassesConnected, progressState, otaProgress?.currentUpdate])

  // Watch for WiFi disconnection during active download/install
  useEffect(() => {
    if (!wifiConnected && (progressState === "downloading" || progressState === "starting")) {
      console.log("OTA: WiFi disconnected during download - showing WiFi disconnected state")
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
      if (postReconnectDelayRef.current) {
        clearTimeout(postReconnectDelayRef.current)
        postReconnectDelayRef.current = null
      }
      waitingForReconnectRef.current = false
      setProgressState("wifi_disconnected")
    }
  }, [wifiConnected, progressState])

  // Track completion timeout to allow cleanup
  const completionTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Track if we're waiting for MTK system install to complete
  const waitingForMtkComplete = useRef(false)

  // Listen for ota_start_ack from glasses — cancels retry timer on confirmed receipt
  useEffect(() => {
    const handleOtaStartAck = (_data: {timestamp: number}) => {
      if (hasReceivedAck.current) return
      hasReceivedAck.current = true
      console.log("OTA: ota_start_ack received — cancelling retry timer")
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
    }

    GlobalEventEmitter.on("ota_start_ack", handleOtaStartAck)

    return () => {
      GlobalEventEmitter.off("ota_start_ack", handleOtaStartAck)
    }
  }, [])

  // Listen for mtk_update_complete event from glasses (sent after system install finishes)
  useEffect(() => {
    const handleMtkUpdateComplete = (data: {message: string; timestamp: number}) => {
      console.log("OTA: Received mtk_update_complete event:", data.message)

      if (waitingForMtkComplete.current) {
        console.log("OTA: MTK system install complete - handling completion")
        waitingForMtkComplete.current = false

        if (progressTimeoutRef.current) {
          clearTimeout(progressTimeoutRef.current)
          progressTimeoutRef.current = null
        }

        // Mark MTK as updated this session
        useGlassesStore.getState().setMtkUpdatedThisSession(true)

        handleUpdateCompleted("mtk")
      }
    }

    GlobalEventEmitter.on("mtk_update_complete", handleMtkUpdateComplete)

    return () => {
      GlobalEventEmitter.off("mtk_update_complete", handleMtkUpdateComplete)
    }
  }, [handleUpdateCompleted])

  // Progress simulation for MTK install stalls
  // Architecture: This effect ONLY depends on otaProgress (real progress from glasses).
  // When real progress arrives, we cancel any existing stall timer and restart it.
  // When the stall timer fires (30s of no real progress in 40-75% zone), we start
  // incrementing by 5% every 30s (matching display granularity for visible changes).
  // The simulation interval updates simulatedProgress state (triggers re-render for UI)
  // but does NOT re-trigger this effect (not in dependency array).
  useEffect(() => {
    const currentUpdate = otaProgress?.currentUpdate
    const realProgress = otaProgress?.progress ?? 0
    const stage = otaProgress?.stage
    const status = otaProgress?.status

    const isMtkInstall =
      currentUpdate === "mtk" && stage === "install" && (status === "STARTED" || status === "PROGRESS")

    // Helper to clear all simulation timers
    const clearAllSimulation = () => {
      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current)
        simulationTimerRef.current = null
      }
      if (stallDetectionRef.current) {
        clearTimeout(stallDetectionRef.current)
        stallDetectionRef.current = null
      }
    }

    // Not MTK install - tear everything down
    if (!isMtkInstall) {
      clearAllSimulation()
      setSimulatedProgress(null)
      return
    }

    // Track real progress
    if (realProgress > 0 && realProgress !== lastRealProgressRef.current) {
      lastRealProgressRef.current = realProgress
      console.log(`🎯 OTA SIMULATION: Real progress updated to ${realProgress}%`)

      // If real progress exceeded simulation, clear simulation
      setSimulatedProgress((prev) => {
        if (prev !== null && realProgress > prev) {
          console.log(`🎯 OTA SIMULATION: Real progress ${realProgress}% exceeded simulated ${prev}%, clearing`)
          return null
        }
        return prev
      })
    }

    // Real progress arrived - cancel existing stall detection and simulation interval
    // (we'll restart stall detection below if still in the zone)
    clearAllSimulation()

    // Set up stall detection if we're in the stall zone (45-55%)
    const inStallZone = realProgress >= 45 && realProgress < 55

    if (inStallZone) {
      // After 20s of no new otaProgress, start/resume simulating
      stallDetectionRef.current = setTimeout(() => {
        const stalledAt = lastRealProgressRef.current

        // Use functional update to never go backwards - start at stalledAt+1 or keep higher prev
        setSimulatedProgress((prev) => {
          let target = prev !== null ? Math.max(prev, stalledAt + 1) : stalledAt + 1
          target = Math.max(target, 51)
          console.log(
            `🎯 OTA SIMULATION: Stall detected at ${stalledAt}%, ${
              prev !== null ? `resuming from ${prev}%` : `starting at ${target}% (min 51%)`
            }`,
          )
          return target
        })

        // Then increment by 1% every 15s (caps at 60%)
        simulationTimerRef.current = setInterval(() => {
          setSimulatedProgress((prev) => {
            const current = prev ?? stalledAt + 1
            const next = current + 1
            const capped = Math.min(next, 60)
            console.log(`🎯 OTA SIMULATION: Incrementing to ${capped}%`)

            if (capped >= 60) {
              console.log(`🎯 OTA SIMULATION: Hit cap at 60%, stopping timer`)
              if (simulationTimerRef.current) {
                clearInterval(simulationTimerRef.current)
                simulationTimerRef.current = null
              }
            }

            return capped
          })
        }, 15000) // 15 seconds between 1% increments
      }, 20000) // 20 seconds before first simulation tick
    }

    return () => {
      clearAllSimulation()
    }
  }, [otaProgress]) // Only react to real progress changes - NOT simulatedProgress

  // Watch for OTA progress updates from glasses
  useEffect(() => {
    const sequence = updateSequenceRef.current
    const expectedStep = sequence[currentUpdateIndex] ?? null

    // OTA_TRACK: always log incoming progress + current state (grep "OTA_TRACK" for full trace)
    console.log(
      "OTA_TRACK: progress_in",
      JSON.stringify({
        received: otaProgress
          ? {
              currentUpdate: otaProgress.currentUpdate,
              stage: otaProgress.stage,
              status: otaProgress.status,
              progress: otaProgress.progress,
            }
          : null,
        state: {
          sequence: [...sequence],
          currentUpdateIndex,
          expectedStep,
          progressState: progressStateRef.current,
          hasReceivedProgress: hasReceivedProgress.current,
        },
      }),
    )

    if (skipStaleProgressRef.current) {
      skipStaleProgressRef.current = false
      console.log("OTA_TRACK: skip_reason=stale_on_mount", JSON.stringify({skipped: otaProgress}))
      return
    }

    if (!otaProgress) {
      console.log("OTA_TRACK: skip_reason=null_progress")
      return
    }

    const {stage, status, currentUpdate} = otaProgress
    const progressSignature = JSON.stringify({
      stage,
      status,
      currentUpdate,
      progress: otaProgress.progress ?? null,
      bytesDownloaded: otaProgress.bytesDownloaded ?? null,
      totalBytes: otaProgress.totalBytes ?? null,
      errorMessage: otaProgress.errorMessage ?? null,
    })

    if (lastProcessedProgressSignatureRef.current === progressSignature) {
      console.log("OTA_TRACK: skip_reason=duplicate", JSON.stringify({currentUpdate, stage, status}))
      return
    }
    lastProcessedProgressSignatureRef.current = progressSignature

    // During install phase, only process events for the step we're currently tracking.
    // During download phase, accept ALL events (unified download progress).
    // Always allow FINISHED through so we don't drop completion when index/expectedStep race.
    if (stage === "install" && expectedStep && currentUpdate !== expectedStep && status !== "FINISHED") {
      console.log(
        "OTA_TRACK: skip_reason=wrong_step_install",
        JSON.stringify({
          expectedStep,
          received: currentUpdate,
          currentUpdateIndex,
          sequence: [...sequence],
        }),
      )
      return
    }

    console.log(
      "OTA_TRACK: processing",
      JSON.stringify({
        currentUpdate,
        stage,
        status,
        progress: otaProgress.progress,
        currentUpdateIndex,
        progressStateBefore: progressStateRef.current,
      }),
    )

    // Mark that we've received progress - stop retrying and cancel the stuck-at-0 timer
    if (!hasReceivedProgress.current) {
      hasReceivedProgress.current = true
      console.log(
        "OTA_TRACK: first_progress_received",
        JSON.stringify({currentUpdate, stage, status, currentUpdateIndex, expectedStep: sequence[currentUpdateIndex]}),
      )
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
      if (stuckTimeoutRef.current) {
        clearTimeout(stuckTimeoutRef.current)
        stuckTimeoutRef.current = null
      }
    }

    // Track completed downloads for aggregate progress
    if (stage === "install" || (stage === "download" && status === "FINISHED")) {
      downloadedUpdatesRef.current.add(currentUpdate)
    }

    // Update the current update index based on what we're receiving (install phase only)
    if (stage === "install") {
      const updateIndex = sequence.indexOf(currentUpdate)
      if (updateIndex !== -1) {
        setCurrentUpdateIndex((prev) => {
          if (prev === updateIndex) return prev
          console.log(
            "OTA_TRACK: index_change",
            JSON.stringify({
              prev,
              next: updateIndex,
              currentUpdate,
              stage,
              status,
              progressState: progressStateRef.current,
            }),
          )
          return updateIndex
        })
      }
    }

    // Reset progress timeout on ANY progress update
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current)
      progressTimeoutRef.current = null
    }

    if (status === "STARTED" || status === "PROGRESS") {
      // Track BES updates for ConnectionOverlay custom message
      if (currentUpdate === "bes") {
        wasFirmwareUpdateRef.current = true
      }

      // MTK: Always show "Installing..." regardless of stage (no download progress shown)
      if (currentUpdate === "mtk") {
        console.log(
          "OTA_TRACK: state_transition",
          JSON.stringify({from: progressStateRef.current, to: "installing", reason: "mtk_STARTED_OR_PROGRESS"}),
        )
        setProgressState("installing")
        progressTimeoutRef.current = setTimeout(() => {
          console.log("OTA: No MTK progress update received in 10 minutes - showing failed")
          setErrorMessage("Update may have failed. Ensure glasses have internet access and try again.")
          setProgressState("failed")
        }, MTK_INSTALL_TIMEOUT_MS)
      } else if (stage === "download") {
        if (!wifiConnected) {
          console.log(
            "OTA_TRACK: state_transition",
            JSON.stringify({from: progressStateRef.current, to: "wifi_disconnected", reason: "download_but_wifi_off"}),
          )
          setProgressState("wifi_disconnected")
          return
        }
        console.log(
          "OTA_TRACK: state_transition",
          JSON.stringify({from: progressStateRef.current, to: "downloading", reason: "stage=download"}),
        )
        setProgressState("downloading")
        progressTimeoutRef.current = setTimeout(() => {
          console.log("OTA: No progress update received in 120s - showing failed")
          setErrorMessage("Update may have failed. Ensure glasses have internet access and try again.")
          setProgressState("failed")
        }, PROGRESS_TIMEOUT_MS)
      } else if (stage === "install") {
        console.log(
          "OTA_TRACK: state_transition",
          JSON.stringify({
            from: progressStateRef.current,
            to: "installing",
            reason: "stage=install_STARTED_OR_PROGRESS",
            currentUpdate,
          }),
        )
        setProgressState("installing")
        progressTimeoutRef.current = setTimeout(() => {
          console.log("OTA: No progress update received in 120s - showing failed")
          setErrorMessage("Update may have failed. Ensure glasses have internet access and try again.")
          setProgressState("failed")
        }, PROGRESS_TIMEOUT_MS)
      }
    } else if (status === "FINISHED") {
      // MTK: Install FINISHED means system install is complete
      if (currentUpdate === "mtk") {
        if (stage === "install") {
          console.log(
            "OTA_TRACK: state_transition",
            JSON.stringify({
              from: progressStateRef.current,
              to: "completed",
              reason: "mtk_install_FINISHED",
              currentUpdateIndex,
            }),
          )

          if (progressTimeoutRef.current) {
            clearTimeout(progressTimeoutRef.current)
            progressTimeoutRef.current = null
          }

          // Mark MTK as updated this session
          useGlassesStore.getState().setMtkUpdatedThisSession(true)

          handleUpdateCompleted("mtk")
        }
        // Ignore download FINISHED - only care about install FINISHED
        return
      }

      if (currentUpdate === "bes") {
        if (stage === "download") {
          console.log(
            "OTA_TRACK: state_transition",
            JSON.stringify({from: progressStateRef.current, reason: "bes_download_FINISHED_wait_install"}),
          )
          progressTimeoutRef.current = setTimeout(() => {
            console.log("OTA: No progress update received in 120s - showing failed")
            setErrorMessage("Update may have failed. Ensure glasses have internet access and try again.")
            setProgressState("failed")
          }, PROGRESS_TIMEOUT_MS)
        } else if (stage === "install") {
          // Ignore duplicate terminal events so reconnect transition cannot be overwritten.
          if (progressStateRef.current === "restarting" || progressStateRef.current === "completed") {
            console.log(
              "OTA_TRACK: skip_reason=duplicate_bes_finished",
              JSON.stringify({currentState: progressStateRef.current}),
            )
            return
          }

          // BES install finished - glasses will power off
          if (progressTimeoutRef.current) {
            clearTimeout(progressTimeoutRef.current)
            progressTimeoutRef.current = null
          }

          const sequenceInner = updateSequenceRef.current
          const besIndex = sequenceInner.indexOf("bes")
          const isLast = besIndex === sequenceInner.length - 1
          console.log(
            "OTA_TRACK: state_transition",
            JSON.stringify({
              from: progressStateRef.current,
              to: "restarting",
              reason: "bes_install_FINISHED",
              besIndex,
              sequenceLength: sequenceInner.length,
              isLast,
              currentUpdateIndex,
            }),
          )
          if (besIndex === sequenceInner.length - 1) {
            // BES is the last update - show restarting, then user can continue
            setProgressState("restarting")
          } else {
            // More updates after BES (unlikely but handle it)
            handleUpdateCompleted("bes")
          }
        } else {
          if (progressTimeoutRef.current) {
            clearTimeout(progressTimeoutRef.current)
            progressTimeoutRef.current = null
          }
          console.log(
            "OTA_TRACK: state_transition",
            JSON.stringify({
              from: progressStateRef.current,
              to: "restarting",
              reason: "bes_finished_unknown_stage",
              stage,
            }),
          )
          setProgressState("restarting")
        }
      } else if (currentUpdate === "apk") {
        if (stage !== "install") {
          console.log("OTA_TRACK: skip_reason=apk_finished_wrong_stage", JSON.stringify({stage, expected: "install"}))
          return
        }
        // APK install FINISHED - show transition after a delay to allow installation
        if (progressTimeoutRef.current) {
          clearTimeout(progressTimeoutRef.current)
          progressTimeoutRef.current = null
        }
        console.log(
          "OTA_TRACK: state_transition",
          JSON.stringify({
            from: progressStateRef.current,
            reason: "apk_install_FINISHED_set_12s_timer",
            currentUpdateIndex,
            sequence: [...updateSequenceRef.current],
          }),
        )
        completionTimeoutRef.current = setTimeout(() => {
          console.log(
            "OTA_TRACK: apk_12s_timer_fired",
            JSON.stringify({currentUpdateIndex, sequence: [...updateSequenceRef.current]}),
          )
          handleUpdateCompleted("apk")
        }, 12000)
      }
    } else if (status === "FAILED") {
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
        progressTimeoutRef.current = null
      }
      console.log(
        "OTA_TRACK: state_transition",
        JSON.stringify({
          from: progressStateRef.current,
          to: "failed",
          reason: "status=FAILED",
          errorMessage: otaProgress.errorMessage,
        }),
      )
      waitingForReconnectRef.current = false
      setErrorMessage(otaProgress.errorMessage || null)
      setProgressState("failed")
    }
  }, [otaProgress, handleUpdateCompleted, currentUpdateIndex, progressState, wifiConnected])

  // Clear global timeout when reaching any terminal state
  useEffect(() => {
    const terminal: ProgressState[] = ["completed", "failed", "disconnected", "restarting", "wifi_disconnected"]
    if (terminal.includes(progressState)) {
      clearGlobalTimeout()
    }
  }, [progressState, clearGlobalTimeout])

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      clearGlobalTimeout()
      if (completionTimeoutRef.current) {
        clearTimeout(completionTimeoutRef.current)
      }
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current)
      }
      if (stallDetectionRef.current) {
        clearTimeout(stallDetectionRef.current)
      }
      if (stuckTimeoutRef.current) {
        clearTimeout(stuckTimeoutRef.current)
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
      if (postReconnectDelayRef.current) {
        clearTimeout(postReconnectDelayRef.current)
      }
    }
  }, [clearGlobalTimeout])

  // Disable Continue button for 15s when entering "restarting" state for BES
  useEffect(() => {
    if (progressState === "restarting" && wasFirmwareUpdateRef.current) {
      console.log("OTA_TRACK: ui_action", JSON.stringify({action: "disable_continue_15s", reason: "bes_restarting"}))
      setContinueButtonDisabled(true)
      const timer = setTimeout(() => {
        console.log(
          "OTA_TRACK: ui_action",
          JSON.stringify({action: "re-enable_continue", reason: "15s_after_restarting"}),
        )
        setContinueButtonDisabled(false)
      }, 15000) // Increased from 5s to 15s
      return () => clearTimeout(timer)
    }
  }, [progressState])

  const navigateAfterContinue = () => {
    // Always re-check for updates after an install completes.
    // The check-for-updates screen handles downstream routing:
    //   - more updates found → install flow continues
    //   - no updates + onboarding pending → onboarding
    //   - no updates + onboarding done → home
    console.log("OTA: Continue pressed - navigating to check-for-updates for re-verification")

    // After an APK install the glasses process restarts and will send fresh version_info.
    // Clear the stale buildNumber so check-for-updates waits for the new value instead of
    // immediately running a check with the old build number (which causes a brief "update
    // available" flicker before the corrected version arrives).
    // IMPORTANT: Clear BOTH native and RN stores so the native ObservableStore dedup
    // doesn't suppress the incoming version_info event (native skips emit when value unchanged).
    const completedUpdate = updateSequenceRef.current[currentUpdateIndex]
    if (completedUpdate === "apk") {
      // Clear native store so future version_info events aren't deduped by ObservableStore
      CoreModule.updateGlasses({buildNumber: ""})
      // Clear RN store synchronously so check-for-updates sees empty buildNumber on mount
      // (the native bridge call is async and may not complete before navigation)
      useGlassesStore.getState().setGlassesInfo({buildNumber: ""})
    }

    replace("/ota/check-for-updates")
  }

  const handleContinue = () => {
    trackButtonPress("continue")
    navigateAfterContinue()
  }

  /** Retry OTA: go back to check-for-updates so the user can start the update again. */
  const handleRetryOta = () => {
    trackButtonPress("retry")
    replace("/ota/check-for-updates")
  }

  const handleRetryFromWifiDisconnected = () => {
    trackButtonPress("try_again")
    handleRetryOta()
  }

  const handleRetryFromFailure = () => {
    handleRetryOta()
  }

  const handleChangeWifi = () => {
    trackButtonPress("change_wifi")
    push("/wifi/scan")
  }

  const handleSkipSuper = () => {
    trackButtonPress("skip_super")
    navigateAfterContinue()
  }

  // Compute displayed update type and progress.
  // Download phase: accept all events, show percentage only for APK (BES/MTK downloads are trivially short).
  // Install phase: track the specific update being installed.
  const expectedUpdate = updateSequenceRef.current[currentUpdateIndex] ?? undefined
  const rawCurrentUpdate = otaProgress?.currentUpdate
  const isStarting = progressState === "starting"
  const currentUpdate = isStarting
    ? expectedUpdate
    : progressState === "downloading"
      ? rawCurrentUpdate
      : (rawCurrentUpdate ?? expectedUpdate)

  // Download progress: only show percentage for APK downloads
  const isApkDownloading = otaProgress?.stage === "download" && otaProgress?.currentUpdate === "apk"
  const downloadProgress = isApkDownloading ? (otaProgress?.progress ?? 0) : 0
  const showDownloadPercent = progressState === "downloading" && isApkDownloading

  // Install progress: use raw progress from the specific install event
  const installProgress = otaProgress?.stage === "install" ? (otaProgress?.progress ?? 0) : 0

  const isSimulating = simulatedProgress !== null && currentUpdate === "mtk" && simulatedProgress > installProgress
  const realProgress = progressState === "downloading" ? downloadProgress : installProgress
  const progress = isStarting ? 0 : isSimulating ? simulatedProgress : realProgress
  const displayProgress = isStarting ? 0 : isSimulating ? progress : Math.round(progress / 5) * 5

  // Get update position string like "Update 1 of 3".
  // Use the step from actual progress when available so we don't show "3 of 3" while
  // glasses are still reporting MTK (e.g. late download STARTED after we advanced to BES).
  const seq = updateSequenceRef.current
  const displayStepIndex =
    otaProgress?.currentUpdate != null && seq.includes(otaProgress.currentUpdate)
      ? seq.indexOf(otaProgress.currentUpdate)
      : currentUpdateIndex

  const renderStepIndicator = () => {
    const total = updateSequenceRef.current.length
    if (total <= 1) return null
    return (
      <Text
        text={`Update ${displayStepIndex + 1} of ${total}`}
        className="text-sm text-center"
        style={{color: theme.colors.textDim}}
      />
    )
  }

  // DEBUG: Log render values
  console.log(
    "🔍 OTA RENDER: progressState:",
    progressState,
    "progress:",
    progress,
    "currentUpdate:",
    currentUpdate,
    "index:",
    currentUpdateIndex,
  )

  const renderTimeEstimation = () => {
    return (
      <View className="bg-primary-foreground rounded-2xl px-6 w-full py-2 mt-12 gap-3 items-center justify-center">
        <View className="flex-row items-center justify-between w-full">
          <Text text="Elapsed time:" className="text-sm text-center" />
          {/* current time - time estimation start time */}
          <Text text={`${elapsedTime ?? "00:00"}`} className="text-sm text-center" />
        </View>
        <View className="flex-row items-center justify-between w-full">
          <Text text={`Estimated time:`} className="text-sm text-center" />
          <Text text="~10min" className="text-sm text-center" />
        </View>
      </View>
    )
  }

  const renderContent = () => {
    console.log(
      "🔍 OTA renderContent: progressState =",
      progressState,
      ", currentUpdate =",
      currentUpdate,
      ", progress =",
      progress,
    )

    // Starting state - waiting for glasses to respond
    if (progressState === "starting") {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text tx="ota:startingUpdate" className="font-semibold text-xl text-center" />
          <View className="h-4" />
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <View className="h-4" />
          <Text tx="ota:doNotDisconnect" className="text-sm text-center text-secondary-foreground" />
          {renderTimeEstimation()}
        </View>
      )
    }

    // Downloading state
    if (progressState === "downloading") {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text text="Downloading Update..." className="font-semibold text-xl text-center" />
          <View className="h-2" />
          {renderStepIndicator()}
          <View className="h-4" />
          {showDownloadPercent ? (
            <Text text={`${displayProgress}%`} className="text-3xl font-bold" style={{color: theme.colors.primary}} />
          ) : (
            <ActivityIndicator size="large" color={theme.colors.foreground} />
          )}
          <View className="h-4" />
          <Text tx="ota:doNotDisconnect" className="text-sm text-center" style={{color: theme.colors.textDim}} />
          {renderTimeEstimation()}
        </View>
      )
    }

    // Installing state
    if (progressState === "installing") {
      const showProgress = currentUpdate === "bes" || currentUpdate === "mtk"
      const isMtk = currentUpdate === "mtk"

      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="settings" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text text="Installing Update..." className="font-semibold text-xl text-center" />
          <View className="h-2" />
          {renderStepIndicator()}
          <View className="h-4" />
          {showProgress && (
            <>
              <Text text={`${displayProgress}%`} className="text-3xl font-bold" style={{color: theme.colors.primary}} />
              <View className="h-4" />
            </>
          )}
          <View className="h-4" />
          {isMtk ? (
            <Text
              text="During the update, please plug the infinity cable into your Mentra Live, or put it in the case to charge. This may take up to 5 minutes."
              className="text-sm text-center"
              style={{color: theme.colors.textDim}}
            />
          ) : (
            <Text tx="ota:doNotDisconnect" className="text-sm text-center" style={{color: theme.colors.textDim}} />
          )}
          {renderTimeEstimation()}
        </View>
      )
    }

    // Restarting state - for BES updates that require power cycle
    // This is shown after BES install finishes and glasses are rebooting/reconnecting
    if (progressState === "restarting") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text text="Update Installed" className="font-semibold text-xl text-center" />
          </View>

          <View className="justify-center items-center">
            <Button
              preset="primary"
              tx="common:continue"
              flexContainer
              onPress={handleContinue}
              disabled={continueButtonDisabled}
            />
          </View>
        </>
      )
    }

    // Completed state - only shown for final update
    if (progressState === "completed") {
      const isMultiStep = updateSequenceRef.current.length > 1
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text
              text={isMultiStep ? "All Updates Installed" : "Update Complete"}
              className="font-semibold text-xl text-center"
            />
            <View className="h-2" />
            <Text
              text="The update has been installed successfully."
              className="text-sm text-center"
              style={{color: theme.colors.textDim}}
            />
          </View>

          <View className="justify-center items-center">
            <Button preset="primary" tx="common:continue" flexContainer onPress={handleContinue} />
          </View>
        </>
      )
    }

    // Disconnected state (BLE) - retry OTA or go to WiFi setup
    if (progressState === "disconnected") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="bluetooth-off" size={64} color={theme.colors.error} />
            <View className="h-6" />
            <Text text="Update Interrupted" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text
              text="Glasses disconnected during update. Please reconnect and try again."
              className="text-sm text-center text-secondary-foreground"
            />
          </View>

          <View className="gap-3">
            <Button preset="primary" text="Retry" flexContainer onPress={handleRetryFromFailure} />
            <Button preset="secondary" text="WiFi setup" flexContainer onPress={handleChangeWifi} />
            {superMode && <Button preset="secondary" text="Skip (super)" onPress={handleSkipSuper} />}
          </View>
        </>
      )
    }

    // WiFi disconnected state - retry OTA or go to WiFi setup
    if (progressState === "wifi_disconnected") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="wifi-off" size={64} color={theme.colors.error} />
            <View className="h-6" />
            <Text text="Update Interrupted" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text
              text="Mentra Live lost its WiFi connection. Please ensure it's connected to WiFi and try again."
              className="text-sm text-center text-secondary-foreground"
            />
          </View>

          <View className="gap-3">
            <Button preset="primary" text="Try Again" flexContainer onPress={handleRetryFromWifiDisconnected} />
            <Button preset="secondary" text="Change WiFi" flexContainer onPress={handleChangeWifi} />
          </View>
        </>
      )
    }

    // Failed state (WiFi still connected) - retry or change WiFi
    return (
      <>
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="warning" size={64} color={theme.colors.error} />
          <View className="h-6" />
          <Text text="Update Failed" className="font-semibold text-xl text-center" />
          {errorMessage ? (
            <>
              <View className="h-2" />
              <Text text={errorMessage} className="text-sm text-center text-secondary-foreground" />
            </>
          ) : null}
          <View className="h-2" />
          <Text
            text="Please try again or connect to a different WiFi network."
            className="text-sm text-center text-secondary-foreground"
          />
        </View>

        <View className="gap-3">
          <Button preset="primary" text="Retry" flexContainer onPress={handleRetryFromFailure} />
          <Button preset="secondary" text="Change WiFi" flexContainer onPress={handleChangeWifi} />
        </View>
      </>
    )
  }

  // Determine if we should show firmware-specific reconnection message.
  // Only show while glasses are actually disconnected during firmware restart.
  const isFirmwareCompleting =
    wasFirmwareUpdateRef.current &&
    !glassesConnected &&
    (progressState === "installing" || progressState === "restarting")

  // Observability: log when firmware reconnect overlay gating changes.
  const lastFirmwareOverlayStateRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (lastFirmwareOverlayStateRef.current !== isFirmwareCompleting) {
      console.log(
        "OTA OBS: firmware overlay gate changed ->",
        JSON.stringify({
          isFirmwareCompleting,
          glassesConnected,
          progressState,
          currentUpdate: otaProgress?.currentUpdate ?? null,
          stage: otaProgress?.stage ?? null,
          status: otaProgress?.status ?? null,
          progress: otaProgress?.progress ?? null,
          wasFirmwareUpdate: wasFirmwareUpdateRef.current,
        }),
      )
      lastFirmwareOverlayStateRef.current = isFirmwareCompleting
    }
  }, [isFirmwareCompleting, glassesConnected, progressState, otaProgress])

  // Track whether we actually observed the expected disconnect during BES restart.
  // We only finalize to completed after a disconnect -> reconnect cycle.
  useEffect(() => {
    if (progressState !== "restarting") {
      sawDisconnectDuringRestartRef.current = false
      return
    }

    if (!glassesConnected && !sawDisconnectDuringRestartRef.current) {
      sawDisconnectDuringRestartRef.current = true
      console.log(
        "OTA_TRACK: restart_disconnect_observed",
        JSON.stringify({
          progressState,
          currentUpdate: otaProgress?.currentUpdate ?? null,
          stage: otaProgress?.stage ?? null,
          status: otaProgress?.status ?? null,
        }),
      )
    }
  }, [progressState, glassesConnected, otaProgress])

  // When glasses reconnect after the observed restart disconnect, transition to completed.
  useEffect(() => {
    if (progressState === "restarting" && glassesConnected && sawDisconnectDuringRestartRef.current) {
      console.log(
        "OTA_TRACK: state_transition",
        JSON.stringify({
          from: "restarting",
          to: "completed",
          reason: "reconnect_after_restart_disconnect",
          currentUpdateIndex,
          sequence: [...updateSequenceRef.current],
        }),
      )
      setProgressState("completed")
    }
  }, [progressState, glassesConnected, otaProgress, completedUpdates, currentUpdateIndex])

  // Update global connection overlay config based on firmware completion state
  const {setConfig, clearConfig} = useConnectionOverlayConfig()
  useEffect(() => {
    if (isFirmwareCompleting) {
      setConfig({
        customTitle: "Please wait while Mentra Live restarts and automatically reconnects...",
        customMessage: "",
        hideStopButton: true,
        smallTitle: true,
      })
    } else {
      clearConfig()
    }

    // Clear config on unmount
    return () => {
      clearConfig()
    }
  }, [isFirmwareCompleting, setConfig, clearConfig])

  // DEBUG: Track state for overlay
  const [debugInfo, setDebugInfo] = useState("")
  useEffect(() => {
    const simulationActive = simulatedProgress !== null
    const simulationStatus = simulationActive
      ? simulationTimerRef.current
        ? `active (${simulatedProgress}%)`
        : `holding (${simulatedProgress}%)`
      : stallDetectionRef.current
        ? "detecting stall..."
        : "none"

    const info = `progressState: ${progressState}
currentUpdate: ${currentUpdate || "null"}
stage: ${otaProgress?.stage || "null"}
status: ${otaProgress?.status || "null"}
realProgress: ${realProgress}%
simulated: ${simulationStatus}
displayProgress: ${displayProgress}%
index: ${currentUpdateIndex}/${updateSequenceRef.current.length}
completed: [${completedUpdates.join(", ")}]`
    setDebugInfo(info)
  }, [
    progressState,
    currentUpdate,
    otaProgress,
    progress,
    currentUpdateIndex,
    completedUpdates,
    simulatedProgress,
    realProgress,
    displayProgress,
  ])

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header RightActionComponent={<MentraLogoStandalone />} />

      {/* DEBUG OVERLAY - Only shows in super mode */}
      {superMode && (
        <View
          style={{
            position: "absolute",
            top: 100,
            left: 10,
            right: 10,
            backgroundColor: "rgba(0,0,0,0.8)",
            padding: 8,
            borderRadius: 8,
            zIndex: 9999,
          }}>
          <Text style={{color: "#0f0", fontSize: 12, fontFamily: "monospace"}}>{debugInfo}</Text>
        </View>
      )}

      {renderContent()}

      {/* Cover video overlay - plays during OTA to reduce perceived wait time */}
      {showCoverVideo && <LoadingCoverVideo videoUrl={OTA_COVER_VIDEO_URL} onClose={handleCoverVideoClosed} />}
    </Screen>
  )
}
