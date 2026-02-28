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
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

type ProgressState =
  | "starting"
  | "downloading"
  | "installing"
  | "transitioning" // NEW: Between updates, waiting for next to start
  | "completed"
  | "failed"
  | "disconnected"
  | "restarting"
  | "wifi_disconnected"

const MAX_RETRIES = 3
const RETRY_INTERVAL_MS = 5000 // 5 seconds between retries
const PROGRESS_TIMEOUT_MS = 120000 // 120 seconds - for APK/BES updates with regular progress
const MTK_INSTALL_TIMEOUT_MS = 300000 // 5 minutes - MTK system install takes much longer with no progress updates
const TRANSITION_TIMEOUT_MS = 30000 // 30 seconds max wait for next update to start
const OTA_COVER_VIDEO_URL = "https://mentra-videos-cdn.mentraglass.com/onboarding/ota/ota_video_2.mp4"

export default function OtaProgressScreen() {
  const {theme} = useAppTheme()
  const {replace, push, pushPrevious, clearHistoryAndGoHome, getHistory} = useNavigationHistory()
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

  // Track the full update sequence and current position
  const updateSequenceRef = useRef<string[]>([])
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
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const progressTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const transitionTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Track initial build number to detect successful install
  const initialBuildNumber = useRef<string | null>(null)
  // Track which update type the build number was captured for
  const buildNumberCapturedForUpdate = useRef<string | null>(null)

  // Track if we're doing a firmware update (persists across reconnection for ConnectionOverlay)
  const wasFirmwareUpdateRef = useRef(false)

  // Cover video state - only show once per OTA session
  const [showCoverVideo, setShowCoverVideo] = useState(false)
  const hasShownVideoRef = useRef(false)

  // Progress simulation for MTK install stall (typically stalls around 49-50%)
  // Uses timeout-based stall detection: when no real progress for 20s in the 45-55% zone,
  // start incrementing by 1% every 15s to keep user informed (caps at 60%)
  const [simulatedProgress, setSimulatedProgress] = useState<number | null>(null)
  const simulationTimerRef = useRef<NodeJS.Timeout | null>(null)
  const stallDetectionRef = useRef<NodeJS.Timeout | null>(null)
  const lastRealProgressRef = useRef<number>(0)

  focusEffectPreventBack()

  // Show cover video when update begins (only once per session)
  useEffect(() => {
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
    console.log("🔍 OTA PROGRESS SCREEN MOUNTED")
    console.log("🔍 OTA MOUNT: Initial otaProgress =", JSON.stringify(otaProgress))
    console.log("🔍 OTA MOUNT: otaUpdateAvailable =", JSON.stringify(otaUpdateAvailable))

    // Capture the update sequence if available
    if (otaUpdateAvailable?.updates && otaUpdateAvailable.updates.length > 0) {
      updateSequenceRef.current = [...otaUpdateAvailable.updates]
      console.log("🔍 OTA MOUNT: Update sequence =", updateSequenceRef.current)
    }

    // Clear any stale OTA progress from previous attempts
    useGlassesStore.getState().setOtaProgress(null)

    return () => {
      console.log("🔍 OTA PROGRESS SCREEN UNMOUNTED")
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
          console.log("OTA REVALIDATE: No more updates needed - marking as completed")
          setProgressState("completed")
        }
        // If we're in transitioning or starting state waiting for next update, but that update was removed,
        // check if we should complete or move to the next one
        else if (progressState === "transitioning" || progressState === "starting") {
          // For starting state, check if current index is still valid
          // For transitioning, check if next index is still valid
          const checkIndex = progressState === "starting" ? currentUpdateIndex : currentUpdateIndex + 1
          if (checkIndex >= updateSequenceRef.current.length) {
            console.log(`OTA REVALIDATE: Was ${progressState} but no more updates - marking as completed`)
            setProgressState("completed")
          }
        }
      }
    }

    revalidateUpdateSequence()
  }, [besFwVersion, mtkFwVersion])

  // Detect successful APK install by watching for build number increase
  // NOTE: This ONLY applies to APK updates which bump the build number on reboot.
  // MTK and BES firmware updates do NOT change the build number - they use FINISHED status instead.
  useEffect(() => {
    // CRITICAL: Only run for APK updates - check this FIRST
    const currentUpdateType = otaProgress?.currentUpdate
    if (currentUpdateType !== "apk") {
      return
    }

    if (progressState !== "installing") return
    if (!buildNumber || !initialBuildNumber.current) return

    // Ensure we captured the initial build number for APK
    if (buildNumberCapturedForUpdate.current !== "apk") {
      console.log("OTA: Build number was not captured for APK update, skipping detection")
      return
    }

    const currentVersion = parseInt(buildNumber, 10)
    const initialVersion = parseInt(initialBuildNumber.current, 10)

    if (!isNaN(currentVersion) && !isNaN(initialVersion) && currentVersion > initialVersion) {
      console.log(`OTA: Build number increased from ${initialVersion} to ${currentVersion} - APK install complete!`)
      // Clear timeouts
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
        progressTimeoutRef.current = null
      }

      // Mark APK as completed
      handleUpdateCompleted("apk")
    }
  }, [buildNumber, progressState, otaProgress?.currentUpdate])

  // Handle when an update completes - transition to next or show final completion
  const handleUpdateCompleted = useCallback(
    (completedUpdate: string) => {
      console.log(`OTA: Update '${completedUpdate}' completed`)

      // Add to completed list
      setCompletedUpdates((prev) => {
        if (prev.includes(completedUpdate)) return prev
        return [...prev, completedUpdate]
      })

      const sequence = updateSequenceRef.current
      const currentIndex = sequence.indexOf(completedUpdate)

      // Check if this was the last update
      if (currentIndex === sequence.length - 1 || currentIndex === -1) {
        console.log("OTA: Final update completed - showing completion screen")
        setProgressState("completed")
        return
      }

      // More updates to come - show transition state
      const nextIndex = currentIndex + 1
      const nextUpdate = sequence[nextIndex]
      console.log(`OTA: Transitioning to next update: ${nextUpdate} (${nextIndex + 1}/${sequence.length})`)

      setCurrentUpdateIndex(nextIndex)
      setProgressState("transitioning")

      // Start transition timeout - if next update doesn't start within 30s, show completed anyway
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current)
      }
      transitionTimeoutRef.current = setTimeout(() => {
        console.log("OTA: Transition timeout - next update didn't start, showing completion")
        setProgressState("completed")
      }, TRANSITION_TIMEOUT_MS)
    },
    [completedUpdates],
  )

  // Send OTA start command with retry logic
  const sendOtaStartCommand = useCallback(async () => {
    try {
      console.log(`OTA: Sending start command to glasses (attempt ${retryCount + 1}/${MAX_RETRIES})`)
      await CoreModule.sendOtaStart()

      // Set up timeout to check if we received progress
      retryTimeoutRef.current = setTimeout(() => {
        if (!hasReceivedProgress.current && progressState === "starting") {
          if (retryCount < MAX_RETRIES - 1) {
            console.log("OTA: No progress received, retrying...")
            setRetryCount((prev) => prev + 1)
          } else {
            console.log("OTA: Max retries reached, failing")
            setErrorMessage("Unable to start update. Glasses did not respond.")
            setProgressState("failed")
          }
        }
      }, RETRY_INTERVAL_MS)
    } catch (error) {
      console.error("OTA: Failed to send start command:", error)
      if (retryCount < MAX_RETRIES - 1) {
        setRetryCount((prev) => prev + 1)
      } else {
        setErrorMessage("Failed to communicate with glasses.")
        setProgressState("failed")
      }
    }
  }, [retryCount, progressState])

  // Initial send and retry on count change
  useEffect(() => {
    // Don't retry if we've already received progress or completed/failed
    if (hasReceivedProgress.current || progressState !== "starting") return

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
      progressState !== "disconnected" &&
      progressState !== "transitioning"
    ) {
      console.log("OTA: Glasses disconnected during update")
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
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
    if (
      !wifiConnected &&
      (progressState === "downloading" || progressState === "starting") &&
      progressState !== "wifi_disconnected" &&
      progressState !== "failed" &&
      progressState !== "completed"
    ) {
      console.log("OTA: WiFi disconnected during download - showing WiFi disconnected state")
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
      setProgressState("wifi_disconnected")
    }
  }, [wifiConnected, progressState])

  // Track completion timeout to allow cleanup
  const completionTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Track if we're waiting for MTK system install to complete
  const waitingForMtkComplete = useRef(false)

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
            `🎯 OTA SIMULATION: Stall detected at ${stalledAt}%, ${prev !== null ? `resuming from ${prev}%` : `starting at ${target}% (min 51%)`}`,
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
    console.log("🔍 OTA EFFECT: otaProgress effect triggered, otaProgress =", otaProgress)
    if (!otaProgress) {
      console.log("🔍 OTA EFFECT: otaProgress is null, returning early")
      return
    }

    const {stage, status, currentUpdate} = otaProgress

    console.log(
      "🔍 OTA EFFECT: Processing - stage:",
      stage,
      "status:",
      status,
      "progress:",
      otaProgress.progress,
      "currentUpdate:",
      currentUpdate,
    )

    // Mark that we've received progress - stop retrying
    if (!hasReceivedProgress.current) {
      hasReceivedProgress.current = true
      console.log("🔍 OTA EFFECT: First progress received, stopping retries")
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
    }

    // Clear transition timeout whenever we receive ANY progress
    // (not just during "transitioning" state - React batching can cause the state to lag behind)
    if (transitionTimeoutRef.current) {
      console.log("OTA: Received progress - clearing transition timeout")
      clearTimeout(transitionTimeoutRef.current)
      transitionTimeoutRef.current = null
    }

    // Update the current update index based on what we're receiving
    const sequence = updateSequenceRef.current
    const updateIndex = sequence.indexOf(currentUpdate)
    if (updateIndex !== -1 && updateIndex !== currentUpdateIndex) {
      console.log(`OTA: Update index changed from ${currentUpdateIndex} to ${updateIndex}`)
      setCurrentUpdateIndex(updateIndex)
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
        console.log("🔍 OTA EFFECT: MTK update - always show installing state")
        setProgressState("installing")
        progressTimeoutRef.current = setTimeout(() => {
          console.log("OTA: No MTK progress update received in 10 minutes - showing failed")
          setErrorMessage("Update may have failed. Ensure glasses have internet access and try again.")
          setProgressState("failed")
        }, MTK_INSTALL_TIMEOUT_MS)
      } else if (stage === "download") {
        console.log("🔍 OTA EFFECT: Setting progressState to 'downloading'")
        setProgressState("downloading")
        progressTimeoutRef.current = setTimeout(() => {
          console.log("OTA: No progress update received in 120s - showing failed")
          setErrorMessage("Update may have failed. Ensure glasses have internet access and try again.")
          setProgressState("failed")
        }, PROGRESS_TIMEOUT_MS)
      } else if (stage === "install") {
        console.log("🔍 OTA EFFECT: Setting progressState to 'installing'")
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
          console.log("OTA: MTK install FINISHED received - install complete")

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
          // Download finished - now waiting for install phase
          console.log("🔍 OTA: BES download FINISHED - waiting for install phase")
          progressTimeoutRef.current = setTimeout(() => {
            console.log("OTA: No progress update received in 120s - showing failed")
            setErrorMessage("Update may have failed. Ensure glasses have internet access and try again.")
            setProgressState("failed")
          }, PROGRESS_TIMEOUT_MS)
        } else if (stage === "install") {
          // BES install finished - glasses will power off
          if (progressTimeoutRef.current) {
            clearTimeout(progressTimeoutRef.current)
            progressTimeoutRef.current = null
          }
          console.log("OTA: BES install FINISHED - glasses will power off")

          // Check if this is the final update
          const sequence = updateSequenceRef.current
          const besIndex = sequence.indexOf("bes")
          if (besIndex === sequence.length - 1) {
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
          console.log("🔍 OTA: BES FINISHED with unknown stage:", stage, "- going to restarting")
          setProgressState("restarting")
        }
      } else if (currentUpdate === "apk") {
        // APK update - show transition after a delay to allow installation
        if (progressTimeoutRef.current) {
          clearTimeout(progressTimeoutRef.current)
          progressTimeoutRef.current = null
        }
        console.log("OTA: APK install FINISHED - will transition after delay")
        completionTimeoutRef.current = setTimeout(() => {
          handleUpdateCompleted("apk")
        }, 12000)
      }
    } else if (status === "FAILED") {
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
        progressTimeoutRef.current = null
      }
      setErrorMessage(otaProgress.errorMessage || null)
      setProgressState("failed")
    }
  }, [otaProgress, handleUpdateCompleted, currentUpdateIndex, progressState])

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (completionTimeoutRef.current) {
        clearTimeout(completionTimeoutRef.current)
      }
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current)
      }
      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current)
      }
      if (stallDetectionRef.current) {
        clearTimeout(stallDetectionRef.current)
      }
    }
  }, [])

  // Disable Continue button for 15s when entering "restarting" state for BES
  // This gives glasses time to reboot before user can proceed
  useEffect(() => {
    if (progressState === "restarting" && wasFirmwareUpdateRef.current) {
      console.log("OTA: BES restarting - disabling Continue button for 15s")
      setContinueButtonDisabled(true)
      const timer = setTimeout(() => {
        console.log("OTA: Re-enabling Continue button")
        setContinueButtonDisabled(false)
      }, 15000) // Increased from 5s to 15s
      return () => clearTimeout(timer)
    }
  }, [progressState])

  const handleContinue = () => {
    const history = getHistory()
    // Check if there's onboarding underneath (initial pairing flow)
    const hasOnboardingUnderneath =
      history.includes("/onboarding/os") || history.includes("/onboarding/live") || history.includes("/onboarding/g1")

    if (hasOnboardingUnderneath) {
      // Initial pairing flow - use pushPrevious to go to onboarding screen underneath
      console.log("OTA: Continue pressed - pushPrevious to onboarding")
      pushPrevious()
    } else {
      // Home OTA alert flow - clear stack and go home
      console.log("OTA: Continue pressed - clearHistoryAndGoHome")
      clearHistoryAndGoHome()
    }
  }

  const handleRetry = () => {
    console.log("OTA: Retry pressed - resetting state")
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current)
      progressTimeoutRef.current = null
    }
    if (transitionTimeoutRef.current) {
      clearTimeout(transitionTimeoutRef.current)
      transitionTimeoutRef.current = null
    }
    setProgressState("starting")
    setRetryCount(0)
    setErrorMessage(null)
    hasReceivedProgress.current = false
  }

  // Use simulated progress if available and higher than real progress (for MTK only)
  const realProgress = otaProgress?.progress ?? 0
  const currentUpdate = otaProgress?.currentUpdate
  const isSimulating = simulatedProgress !== null && currentUpdate === "mtk" && simulatedProgress > realProgress
  const progress = isSimulating ? simulatedProgress : realProgress
  // Round real progress to nearest 5%, but show exact 1% increments during simulation
  const displayProgress = isSimulating ? progress : Math.round(progress / 5) * 5

  // Get update position string like "Update 1 of 3"
  const getUpdatePositionString = (): string => {
    const sequence = updateSequenceRef.current
    if (sequence.length <= 1) {
      return "Update"
    }
    const index = currentUpdateIndex + 1
    return `Update ${index} of ${sequence.length}`
  }

  // Get next update position string like "update 2 of 3"
  const getNextUpdatePositionString = (): string => {
    const sequence = updateSequenceRef.current
    const nextIndex = currentUpdateIndex + 1
    if (nextIndex >= sequence.length) {
      return "next update"
    }
    return `update ${nextIndex + 1} of ${sequence.length}`
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

  const renderContent = () => {
    console.log(
      "🔍 OTA renderContent: progressState =",
      progressState,
      ", currentUpdate =",
      currentUpdate,
      ", progress =",
      progress,
    )

    const updatePosition = getUpdatePositionString()

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
        </View>
      )
    }

    // Transitioning state - between updates, waiting for next to start
    if (progressState === "transitioning") {
      const nextPosition = getNextUpdatePositionString()
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text text={`Starting ${nextPosition}...`} className="font-semibold text-xl text-center" />
          <View className="h-4" />
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <View className="h-4" />
          <Text
            text="Please wait while the next update begins."
            className="text-sm text-center"
            style={{color: theme.colors.textDim}}
          />
        </View>
      )
    }

    // Downloading state
    if (progressState === "downloading") {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text text={`Downloading ${updatePosition}...`} className="font-semibold text-xl text-center" />
          <View className="h-4" />
          <Text text={`${displayProgress}%`} className="text-3xl font-bold" style={{color: theme.colors.primary}} />
          <View className="h-4" />
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <View className="h-4" />
          <Text tx="ota:doNotDisconnect" className="text-sm text-center" style={{color: theme.colors.textDim}} />
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
          <Text text={`Installing ${updatePosition}...`} className="font-semibold text-xl text-center" />
          <View className="h-4" />
          {showProgress && (
            <>
              <Text text={`${displayProgress}%`} className="text-3xl font-bold" style={{color: theme.colors.primary}} />
              <View className="h-4" />
            </>
          )}
          <ActivityIndicator size="large" color={theme.colors.foreground} />
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
        </View>
      )
    }

    // Restarting state - for BES updates that require power cycle
    // This is shown after BES install finishes and glasses are rebooting/reconnecting
    if (progressState === "restarting") {
      const allUpdatesCount = updateSequenceRef.current.length
      const titleText = allUpdatesCount > 1 ? "Updates Installed" : "Update Installed"

      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text text={titleText} className="font-semibold text-xl text-center" />
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
      const allUpdatesCount = updateSequenceRef.current.length
      const titleText = allUpdatesCount > 1 ? "Updates Complete" : "Update Complete"
      const completedMessage =
        allUpdatesCount > 1
          ? "All updates have been installed successfully."
          : "The update has been installed successfully."

      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text text={titleText} className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text text={completedMessage} className="text-sm text-center" style={{color: theme.colors.textDim}} />
          </View>

          <View className="justify-center items-center">
            <Button preset="primary" tx="common:continue" flexContainer onPress={handleContinue} />
          </View>
        </>
      )
    }

    // Disconnected state (BLE) - retry only
    if (progressState === "disconnected") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="bluetooth-off" size={64} color={theme.colors.error} />
            <View className="h-6" />
            <Text text={`${updatePosition} Interrupted`} className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text
              text="Glasses disconnected during update. Please reconnect and try again."
              className="text-sm text-center text-secondary-foreground"
            />
          </View>

          <View className="gap-3 pb-2">
            <Button preset="primary" tx="Retry" flexContainer onPress={handleRetry} />
            {superMode && <Button preset="secondary" text="Skip (super)" onPress={handleContinue} />}
          </View>
        </>
      )
    }

    // WiFi disconnected state - navigate to WiFi setup
    if (progressState === "wifi_disconnected") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="wifi-off" size={64} color={theme.colors.error} />
            <View className="h-6" />
            <Text text={`${updatePosition} Interrupted`} className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text
              text="WiFi disconnected during update. Please reconnect to WiFi to continue."
              className="text-sm text-center text-secondary-foreground"
            />
          </View>

          <View className="gap-3 pb-2">
            <Button preset="primary" tx="common:continue" flexContainer onPress={() => push("/wifi/scan")} />
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
          <Text text={`${updatePosition} Failed`} className="font-semibold text-xl text-center" />
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

        <View className="gap-3 pb-2">
          <Button preset="primary" tx="Retry" flexContainer onPress={() => replace("/ota/check-for-updates")} />
          <Button preset="secondary" text="Change WiFi" flexContainer onPress={() => push("/wifi/scan")} />
        </View>
      </>
    )
  }

  // Determine if we should show firmware-specific reconnection message
  const isFirmwareCompleting =
    wasFirmwareUpdateRef.current &&
    (progressState === "completed" || progressState === "restarting" || otaProgress?.progress === 100)

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
