import {useRoute} from "@react-navigation/native"
import {waitForGlassesReady, BluetoothSdk} from "@mentra/island"
import type {PairFailureEvent, GlassesNotReadyEvent, PairingInfoEvent} from "@mentra/island"
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
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {selectGlassesReady, useGlassesStore} from "@/stores/glasses"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"

// Field firmware does not emit the pairing_info handshake. Once the glasses are fully booted,
// wait this long for pairing_info before treating its absence as had_previous_bond=false so
// pairing does not hang forever on units running firmware without the new handshake.
const PAIRING_INFO_FALLBACK_MS = 5_000

export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationStore.getState()
  const route = useRoute()
  const {deviceModel, deviceName} = route.params as {deviceModel: string; deviceName?: string}
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const showGlassesBootingRef = useRef(false)
  const hasSubmittedTimeoutIncidentRef = useRef(false)
  const hasNavigatedRef = useRef(false)
  const glassesFullyBooted = useGlassesStore(selectGlassesReady)
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)
  const pairingInfoRef = useRef<boolean | null>(null)
  const [pairingResolved, setPairingResolved] = useState(false)
  const [pairingInfoReceived, setPairingInfoReceived] = useState(false)
  const [pairingInfoTimedOut, setPairingInfoTimedOut] = useState(false)
  const wipePromptShownRef = useRef(false)
  const isMentraLive = deviceModel === DeviceTypes.LIVE

  useEffect(() => {
    let sub = BluetoothSdk.addListener("glasses_not_ready", (_event: GlassesNotReadyEvent) => {
      setShowGlassesBooting(true)
    })
    return () => {
      sub.remove()
    }
  }, [])

  useEffect(() => {
    if (!isMentraLive) {
      return
    }

    const sub = BluetoothSdk.addListener("pairing_info", (event: PairingInfoEvent) => {
      pairingInfoRef.current = event.had_previous_bond
      setPairingInfoReceived(true)
      if (!event.had_previous_bond) {
        setPairingResolved(true)
      }
    })

    return () => {
      sub.remove()
    }
  }, [isMentraLive])

  focusEffectPreventBack()

  const handleGoBack = useCallback(() => {
    goBack()
  }, [goBack])

  const abortPairingTransfer = useCallback(async () => {
    try {
      await BluetoothSdk.abortPairingTransfer()
    } catch (error) {
      console.error("Failed to abort pairing transfer:", error)
    }
    await BluetoothSdk.disconnect()
    BluetoothSdk.forget()
    replace("/pairing/prep", {deviceModel})
    showAlert(translate("pairing:pairingCancelledTitle"), translate("pairing:pairingCancelledMessage"), [
      {text: translate("common:ok")},
    ])
  }, [deviceModel, replace])

  const confirmMediaWipe = useCallback(async () => {
    try {
      const result = await BluetoothSdk.wipeMediaForPairing()
      if (!result.success) {
        throw new Error("wipe_media_failed")
      }
      await BluetoothSdk.finalizePairingTransfer()
      setPairingResolved(true)
    } catch (error) {
      console.error("Failed to wipe media during pairing:", error)
      await abortPairingTransfer()
    }
  }, [abortPairingTransfer])

  const promptMediaWipe = useCallback(() => {
    if (wipePromptShownRef.current) {
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

  const checkGalleryAndHandleOwnershipTransfer = useCallback(async () => {
    try {
      const galleryStatus = await BluetoothSdk.queryGalleryStatus()
      if (galleryStatus.total > 0) {
        promptMediaWipe()
      } else {
        // Gallery is already empty — finalize silently, no wipe needed
        await BluetoothSdk.finalizePairingTransfer()
        setPairingResolved(true)
      }
    } catch (error) {
      console.error("Failed to query gallery status during pairing transfer:", error)
      // Fallback: show wipe prompt so user can decide
      promptMediaWipe()
    }
  }, [promptMediaWipe])

  const handlePairFailure = useCallback(
    (error: string) => {
      BluetoothSdk.forget()
      if (error === "errors:pairNeedDisconnect") {
        replace("/pairing/unpair-even", {deviceModel: deviceModel})
        return
      }
      replace("/pairing/failure", {error: error, deviceModel: deviceModel})
    },
    [replace, deviceModel],
  )

  useEffect(() => {
    let sub = BluetoothSdk.addListener("pair_failure", (event: PairFailureEvent) => {
      handlePairFailure(event.error)
    })
    return () => {
      sub.remove()
    }
  }, [handlePairFailure])

  useEffect(() => {
    showGlassesBootingRef.current = showGlassesBooting
  }, [showGlassesBooting])

  useEffect(() => {
    hasSubmittedTimeoutIncidentRef.current = false
    const controller = new AbortController()

    void waitForGlassesReady({
      getConnection: () => useGlassesStore.getState().connection,
      subscribe: (listener) => useGlassesStore.subscribe((s) => s.connection, listener),
      timeoutMs: 35_000,
      signal: controller.signal,
    }).then((ready) => {
      if (ready || controller.signal.aborted || hasSubmittedTimeoutIncidentRef.current) {
        return
      }
      hasSubmittedTimeoutIncidentRef.current = true
      const actualBehavior = JSON.stringify(
        {
          deviceModel,
          deviceName,
          showGlassesBooting: showGlassesBootingRef.current,
          elapsedMs: 35_000,
          route: "/pairing/loading",
        },
        null,
        2,
      )

      void submitAutomaticBugIncident({
        categorization: {
          submissionMode: "AUTOMATIC",
          triggerArea: "pairing_loading",
          triggerReason: "glasses_connect_timeout",
        },
        expectedBehavior: "Glasses should connect successfully within 35 seconds.",
        actualBehavior,
        severityRating: 4,
        dedupeKey: `pairing_timeout|${deviceModel}|${deviceName || "unknown"}`,
        logTag: "PairingTimeoutBugReport",
      })
    })

    return () => {
      controller.abort()
    }
  }, [deviceModel, deviceName])

  useEffect(() => {
    if (!isMentraLive || !glassesFullyBooted || pairingInfoReceived || pairingInfoTimedOut) {
      return
    }
    const timer = setTimeout(() => {
      setPairingInfoTimedOut(true)
    }, PAIRING_INFO_FALLBACK_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [isMentraLive, glassesFullyBooted, pairingInfoReceived, pairingInfoTimedOut])

  useEffect(() => {
    if (!glassesFullyBooted) {
      return
    }
    if (hasNavigatedRef.current) {
      return
    }

    if (isMentraLive) {
      if (!pairingInfoReceived && !pairingInfoTimedOut) {
        return
      }
      if (pairingInfoReceived && pairingInfoRef.current === true && !pairingResolved) {
        void checkGalleryAndHandleOwnershipTransfer()
        return
      }
    }

    hasNavigatedRef.current = true
    setTimeout(() => {
      replace("/pairing/success", {deviceModel: deviceModel})
    }, 1000)
  }, [
    glassesFullyBooted,
    replace,
    deviceModel,
    isMentraLive,
    pairingInfoReceived,
    pairingInfoTimedOut,
    pairingResolved,
    checkGalleryAndHandleOwnershipTransfer,
  ])

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header leftIcon="chevron-left" onLeftPress={handleGoBack} />
      <View className="flex-1">
        <View className="flex-1 justify-center">
          <GlassesPairingLoader
            deviceModel={deviceModel}
            deviceName={deviceName}
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
