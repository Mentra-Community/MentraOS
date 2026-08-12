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
  const pairingResolvedRef = useRef(false)
  const [pairingInfoReceived, setPairingInfoReceived] = useState(false)
  const [pairingInfoTimedOut, setPairingInfoTimedOut] = useState(false)
  const wipePromptShownRef = useRef(false)
  const ownershipInFlightRef = useRef(false)
  const tearedDownRef = useRef(false)
  const isMentraLive = deviceModel === DeviceTypes.LIVE

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
      if (!event.had_previous_bond) {
        pairingResolvedRef.current = true
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
    if (
      isMentraLive &&
      !pairingResolvedRef.current &&
      (pairingInfoReceived || ownershipInFlightRef.current || pairingInfoRef.current?.had_previous_bond === true)
    ) {
      void abortPairingTransfer()
      return
    }
    goBack()
  }, [goBack, isMentraLive, pairingInfoReceived, abortPairingTransfer])

  const finalizeOwnershipTransfer = useCallback(async () => {
    // Await classic readiness when BES reported required bond present; do not deadlock
    // if classic was never requested (plan anti-deadlock rule).
    const info = pairingInfoRef.current
    if (info?.classic_bond_ready === false && info?.secure_pairing_capable) {
      await engine.pairing.waitForBluetoothClassic({timeoutMs: 8_000}).catch(() => false)
    }
    try {
      const finalize = await BluetoothSdk.finalizePairingTransfer()
      if (!finalize.success) {
        throw new Error(finalize.error || "finalize_failed")
      }
      pairingResolvedRef.current = true
      setPairingResolved(true)
    } catch (finalizeError) {
      // The finalize response can time out after the glasses have already committed.
      // Reconcile once before aborting so a lost acknowledgement does not undo a
      // successful ownership transfer.
      try {
        // User cancel/teardown wins over a late status reconciliation.
        if (tearedDownRef.current) {
          throw finalizeError
        }
        const status = await BluetoothSdk.getPairingTransferStatus(info?.transfer_id)
        const finalized =
          status.state === "committed" || status.state === "success" || status.terminal_operation === "finalize"
        if (finalized && !tearedDownRef.current) {
          pairingResolvedRef.current = true
          setPairingResolved(true)
          return
        }
      } catch (statusError) {
        console.warn("Failed to reconcile pairing transfer status:", statusError)
      }
      throw finalizeError
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
      if (!ENABLE_PAIRING_MEDIA_WIPE) {
        // Wipe kept in codebase but disabled: finalize ownership without deleting media.
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

  useEffect(() => {
    if (!isMentraLive || !pairingInfoReceived || pairingInfoRef.current?.had_previous_bond !== true || pairingResolved) {
      return
    }
    if (navigationTimerRef.current) {
      clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
      hasNavigatedRef.current = false
    }
    void handleOwnershipTransfer()
  }, [isMentraLive, pairingInfoReceived, pairingResolved, handleOwnershipTransfer])

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
      if (pairingInfoReceived && pairingInfoRef.current?.had_previous_bond === true && !pairingResolved) {
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
  ])

  useEffect(() => {
    return () => {
      if (navigationTimerRef.current) {
        clearTimeout(navigationTimerRef.current)
      }
      // Best-effort abort on controlled unmount during active transfer.
      if (
        isMentraLive &&
        pairingInfoRef.current?.had_previous_bond === true &&
        !pairingResolvedRef.current &&
        !tearedDownRef.current
      ) {
        tearedDownRef.current = true
        void BluetoothSdk.abortPairingTransfer().catch(() => undefined)
      }
    }
  }, [isMentraLive])

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
