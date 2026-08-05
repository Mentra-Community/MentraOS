import {useRoute} from "@react-navigation/native"
import BluetoothSdk, {type PairingInfoEvent} from "@mentra/bluetooth-sdk"
import {engine} from "@mentra/engine"
import type {PairFailureEvent} from "@mentra/engine"
import {useCallback, useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {Button} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"

// Legacy ads without secure_pairing_capable use this timeout. Secure firmware must not.
const PAIRING_INFO_FALLBACK_MS = 5_000

// Secure-capable glasses skip the legacy fallback above and wait for a real pairing_info
// event instead. If it never arrives (BLE wire issue, firmware bug, etc.) we would otherwise
// wait forever with no feedback — surface troubleshooting instead of hanging silently.
const PAIRING_INFO_SECURE_HARD_TIMEOUT_MS = 45_000

// Finalize can legitimately time out mid-handshake without the transfer having failed. Retry
// a bounded number of times, checking status between attempts, before giving up.
const MAX_FINALIZE_ATTEMPTS = 3

/** When false, keep wipe UX/SDK paths but skip deleting previous-owner media during pairing. */
const ENABLE_PAIRING_MEDIA_WIPE = false

export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationStore.getState()
  const route = useRoute()
  const {deviceModel, deviceName, ar99ProjectName, securePairingCapable} = route.params as {
    deviceModel: string
    deviceName?: string
    ar99ProjectName?: string
    /** Known upfront from the scan result's advertised capability, before any pairing_info event. */
    securePairingCapable?: boolean
  }
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const hasNavigatedRef = useRef(false)
  const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const glassesFullyBooted = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  ).fullyBooted
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)
  const pairingInfoRef = useRef<PairingInfoEvent | null>(null)
  const [pairingResolved, setPairingResolved] = useState(false)
  const [pairingInfoReceived, setPairingInfoReceived] = useState(false)
  const [pairingInfoTimedOut, setPairingInfoTimedOut] = useState(false)
  const wipePromptShownRef = useRef(false)
  const ownershipInFlightRef = useRef(false)
  const tearedDownRef = useRef(false)
  // Once true, a finalize call has been sent to the glasses for the active transfer (whether
  // it's still in flight, timed out with an unknown outcome, or being retried). From that point
  // on we must never auto-abort — the glasses may have already committed the transfer — so
  // cleanup on unmount/back becomes a no-op instead of aborting.
  const finalizeAttemptedRef = useRef(false)
  const isMentraLive = deviceModel === DeviceTypes.LIVE

  /** A pairing_info event that requires the phone to finalize (or abort) the transfer. */
  const isPairingTransferActive = useCallback(() => {
    const info = pairingInfoRef.current
    return info?.had_previous_bond === true || info?.secure_pairing_capable === true
  }, [])

  useEffect(() => {
    const unsub = engine.pairing.onGlassesNotReady(() => {
      setShowGlassesBooting(true)
    })
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!isMentraLive) {
      return
    }

    const sub = BluetoothSdk.addListener("pairing_info", (event: PairingInfoEvent) => {
      if (tearedDownRef.current) return
      pairingInfoRef.current = event
      setPairingInfoReceived(true)
      // Finalize is required whenever there's a transfer to close out: a previous owner's
      // bond being migrated (had_previous_bond), or a brand-new secure pairing handshake
      // (secure_pairing_capable) — the "first owner" must also finalize, not just take-overs.
      // Only a legacy, non-secure, fresh pairing has nothing left for the phone to do.
      if (!event.had_previous_bond && !event.secure_pairing_capable) {
        setPairingResolved(true)
      }
    })

    return () => {
      sub.remove()
    }
  }, [isMentraLive])

  const abortPairingTransfer = useCallback(async () => {
    if (tearedDownRef.current) return
    tearedDownRef.current = true
    try {
      await BluetoothSdk.abortPairingTransfer()
    } catch (error) {
      console.error("Failed to abort pairing transfer:", error)
    }
    try {
      await BluetoothSdk.disconnect()
      await BluetoothSdk.forget()
    } catch (error) {
      console.warn("Failed to disconnect/forget after abort:", error)
    }
    replace("/pairing/prep", {deviceModel})
    showAlert(translate("pairing:pairingCancelledTitle"), translate("pairing:pairingCancelledMessage"), [
      {text: translate("common:ok")},
    ])
  }, [deviceModel, replace])

  const handleGoBack = useCallback(() => {
    // Once finalize has been attempted, the transfer may already be committed on the glasses
    // (or its outcome may be unknown after a timeout) — aborting at that point could race a
    // transfer the glasses already completed, so back simply navigates away without aborting.
    if (isMentraLive && isPairingTransferActive() && !pairingResolved && !finalizeAttemptedRef.current) {
      void abortPairingTransfer()
      return
    }
    goBack()
  }, [goBack, isMentraLive, pairingResolved, abortPairingTransfer, isPairingTransferActive])

  const finalizeOwnershipTransfer = useCallback(async () => {
    // Await classic readiness when BES reported required bond present; do not deadlock
    // if classic was never requested (plan anti-deadlock rule).
    const info = pairingInfoRef.current
    if (info?.classic_bond_ready === false && info?.secure_pairing_capable) {
      const classicReady = await engine.pairing.waitForBluetoothClassic({timeoutMs: 8_000}).catch(() => false)
      if (!classicReady) {
        // Bluetooth Classic bonding didn't confirm in time. Do not block finalize on it —
        // the transfer may still complete on a degraded/temporal binding — but log so this
        // is visible if it turns out to correlate with pairing failures.
        console.warn(
          "[Pairing] Bluetooth Classic bond not confirmed ready before finalize deadline; proceeding with finalize anyway (degraded/temporal binding).",
        )
      }
    }

    for (let attempt = 1; attempt <= MAX_FINALIZE_ATTEMPTS; attempt++) {
      finalizeAttemptedRef.current = true
      try {
        const finalize = await BluetoothSdk.finalizePairingTransfer()
        if (!finalize.success) {
          throw new Error(finalize.error || "finalize_failed")
        }
        setPairingResolved(true)
        return
      } catch (error) {
        const code = (error as {code?: string} | undefined)?.code
        // Only a request_timeout is ambiguous (the glasses may have already committed the
        // transfer) — anything else is a definite failure and propagates immediately.
        if (code !== "request_timeout" || tearedDownRef.current) {
          throw error
        }
        console.warn(`[Pairing] finalize timed out (attempt ${attempt}/${MAX_FINALIZE_ATTEMPTS}); querying transfer status instead of aborting.`)
        let terminalState: string | null = null
        try {
          const status = await BluetoothSdk.getPairingTransferStatus()
          if (status.state === "committed") {
            setPairingResolved(true)
            return
          }
          if (status.state === "aborted" || status.state === "expired") {
            terminalState = status.state
          }
          // Otherwise state is "active"/"unknown"/etc — outcome still undetermined, retry
          // finalize below.
        } catch (statusError) {
          console.warn("[Pairing] getPairingTransferStatus failed after finalize timeout:", statusError)
        }
        if (terminalState) {
          throw new Error(`pairing_transfer_${terminalState}`)
        }
        if (attempt === MAX_FINALIZE_ATTEMPTS) {
          throw error
        }
      }
    }
  }, [])

  const confirmMediaWipe = useCallback(async () => {
    try {
      if (ENABLE_PAIRING_MEDIA_WIPE) {
        const result = await BluetoothSdk.wipeMediaForPairing()
        if (!result.success) {
          throw new Error(result.error || "wipe_media_failed")
        }
      }
      await finalizeOwnershipTransfer()
    } catch (error) {
      console.error("Failed to wipe media during pairing:", error)
      wipePromptShownRef.current = false
      showAlert(translate("pairing:wipeMediaTitle"), translate("pairing:wipeMediaMessage"), [
        {
          text: translate("common:cancel"),
          style: "destructive",
          onPress: () => {
            void abortPairingTransfer()
          },
        },
        {
          text: translate("pairing:tryAgain"),
          onPress: () => {
            void confirmMediaWipe()
          },
        },
      ])
    }
  }, [abortPairingTransfer, finalizeOwnershipTransfer])

  const promptMediaWipe = useCallback(() => {
    if (wipePromptShownRef.current || tearedDownRef.current) {
      return
    }
    wipePromptShownRef.current = true

    showAlert(translate("pairing:wipeMediaTitle"), translate("pairing:wipeMediaMessage"), [
      {
        text: translate("common:cancel"),
        style: "destructive",
        onPress: () => {
          void abortPairingTransfer()
        },
      },
      {
        text: translate("pairing:wipeMediaConfirm"),
        onPress: () => {
          void confirmMediaWipe()
        },
      },
    ])
  }, [abortPairingTransfer, confirmMediaWipe])

  const handleOwnershipTransfer = useCallback(async () => {
    if (ownershipInFlightRef.current || tearedDownRef.current) {
      return
    }
    ownershipInFlightRef.current = true
    try {
      const hadPreviousBond = pairingInfoRef.current?.had_previous_bond === true
      // Wipe UX only applies to take-overs (had_previous_bond) with the feature enabled. A
      // first-time/secure pairing with no previous owner has nothing to wipe and finalizes
      // directly.
      if (!hadPreviousBond || !ENABLE_PAIRING_MEDIA_WIPE) {
        await finalizeOwnershipTransfer()
        return
      }
      // Always require confirmation when had_previous_bond — even if gallery is empty.
      promptMediaWipe()
    } catch (error) {
      console.error("Failed to finalize pairing transfer without wipe:", error)
      void abortPairingTransfer()
    } finally {
      ownershipInFlightRef.current = false
    }
  }, [abortPairingTransfer, finalizeOwnershipTransfer, promptMediaWipe])

  const handlePairFailure = useCallback(
    (error: string) => {
      void engine.pairing.abandonAttempt().catch((cleanupError) => {
        console.warn("Pairing failure cleanup failed:", cleanupError)
      })
      if (error === "errors:pairNeedDisconnect") {
        replace("/pairing/unpair-even", {deviceModel: deviceModel})
        return
      }
      replace("/pairing/failure", {error: error, deviceModel: deviceModel})
    },
    [replace, deviceModel],
  )

  useEffect(() => {
    const unsub = engine.pairing.onPairFailure((event: PairFailureEvent) => {
      handlePairFailure(event.error)
    })
    return () => {
      unsub()
    }
  }, [handlePairFailure])

  useEffect(() => {
    const controller = new AbortController()

    void engine.pairing.waitForReady({
      deviceModel,
      deviceName,
      timeoutMs: 35_000,
      route: "/pairing/loading",
      signal: controller.signal,
    })

    return () => {
      controller.abort()
    }
  }, [deviceModel, deviceName])

  useEffect(() => {
    if (!isMentraLive || !glassesFullyBooted || pairingInfoReceived || pairingInfoTimedOut) {
      return
    }
    // Secure-capable firmware must not use the legacy pairing_info timeout fallback.
    // Check the capability known upfront from the scan result (0xB822 advertised flag) so a
    // secure device whose pairing_info is merely slow can't have this timer race it and mark
    // pairing successful before the ownership-transfer state ever arrives. Only fall back to the
    // pairing_info ref (which is unset until the event arrives) when the scan didn't tell us.
    if (securePairingCapable === true || pairingInfoRef.current?.secure_pairing_capable) {
      return
    }
    const timer = setTimeout(() => {
      setPairingInfoTimedOut(true)
    }, PAIRING_INFO_FALLBACK_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [isMentraLive, glassesFullyBooted, pairingInfoReceived, pairingInfoTimedOut, securePairingCapable])

  // Hard safety net for secure-capable glasses: they deliberately skip the legacy fallback
  // above and wait indefinitely for a real pairing_info event. If it never arrives, surface
  // troubleshooting instead of leaving the user staring at a loader forever.
  useEffect(() => {
    if (!isMentraLive || !glassesFullyBooted || pairingInfoReceived || securePairingCapable !== true) {
      return
    }
    const timer = setTimeout(() => {
      if (tearedDownRef.current || pairingInfoRef.current) {
        return
      }
      console.warn("[Pairing] pairing_info never arrived on secure device after hard timeout; surfacing troubleshooting.")
      setShowTroubleshootingModal(true)
    }, PAIRING_INFO_SECURE_HARD_TIMEOUT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [isMentraLive, glassesFullyBooted, pairingInfoReceived, securePairingCapable])

  useEffect(() => {
    if (!isMentraLive || !pairingInfoReceived || !isPairingTransferActive() || pairingResolved) {
      return
    }
    if (navigationTimerRef.current) {
      clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
      hasNavigatedRef.current = false
    }
    void handleOwnershipTransfer()
  }, [isMentraLive, pairingInfoReceived, pairingResolved, handleOwnershipTransfer, isPairingTransferActive])

  useEffect(() => {
    if (!glassesFullyBooted) {
      return
    }
    if (hasNavigatedRef.current) {
      return
    }

    if (isMentraLive) {
      const secure = securePairingCapable === true || pairingInfoRef.current?.secure_pairing_capable === true
      if (!pairingInfoReceived && !pairingInfoTimedOut) {
        return
      }
      if (secure && !pairingInfoReceived) {
        return
      }
      // Block auto-navigation to success while a transfer (take-over OR first-owner secure
      // pairing) is still finalizing.
      if (pairingInfoReceived && isPairingTransferActive() && !pairingResolved) {
        return
      }
    }

    hasNavigatedRef.current = true
    navigationTimerRef.current = setTimeout(() => {
      replace("/pairing/success", {deviceModel: deviceModel, ar99ProjectName})
    }, 1000)
  }, [
    glassesFullyBooted,
    replace,
    deviceModel,
    isMentraLive,
    pairingInfoReceived,
    pairingInfoTimedOut,
    pairingResolved,
    ar99ProjectName,
    securePairingCapable,
    isPairingTransferActive,
  ])

  useEffect(() => {
    return () => {
      if (navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
      }
      // Best-effort abort on controlled unmount — but only if a transfer is active AND
      // finalize was never attempted. Once finalize has been sent (in flight, or timed out
      // with an unknown outcome), the glasses may have already committed the transfer, so
      // aborting here could race a completed transfer. In that case we deliberately leave it
      // alone; a future getPairingTransferStatus()/finalize retry can still recover it.
      if (
        isMentraLive &&
        isPairingTransferActive() &&
        !pairingResolved &&
        !finalizeAttemptedRef.current &&
        !tearedDownRef.current
      ) {
        tearedDownRef.current = true
        void BluetoothSdk.abortPairingTransfer().catch(() => undefined)
      }
    }
  }, [isMentraLive, pairingResolved, isPairingTransferActive])

  focusEffectPreventBack()

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header leftIcon="chevron-left" onLeftPress={handleGoBack} />
      <View className="flex-1">
        <View className="flex-1 justify-center">
          <GlassesPairingLoader
            deviceModel={deviceModel}
            deviceName={deviceName}
            ar99ProjectName={ar99ProjectName}
            isBooting={showGlassesBooting}
            onCancel={handleGoBack}
          />
        </View>
        <Button
          preset="secondary"
          tx="pairing:needMoreHelp"
          onPress={() => setShowTroubleshootingModal(true)}
          className="w-full"
        />
      </View>
      <GlassesTroubleshootingModal
        isVisible={showTroubleshootingModal}
        onClose={() => setShowTroubleshootingModal(false)}
        deviceModel={deviceModel}
      />
    </Screen>
  )
}
