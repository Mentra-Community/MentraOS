import {useRoute} from "@react-navigation/native"
import CoreModule, {PairFailureEvent, GlassesNotReadyEvent} from "@mentra/bluetooth-sdk"
import {useCallback, useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {Button} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {useGlassesStore} from "@/stores/glasses"
import {useNavigationStore} from "@/stores/navigation"

export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationStore.getState()
  const route = useRoute()
  const {deviceModel, deviceName} = route.params as {deviceModel: string; deviceName?: string}
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const glassesFullyBootedRef = useRef(false)
  const showGlassesBootingRef = useRef(false)
  const hasSubmittedTimeoutIncidentRef = useRef(false)
  const hasNavigatedRef = useRef(false)
  const glassesFullyBooted = useGlassesStore((state) => state.fullyBooted)
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)

  const clearPairingTimeout = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    let sub = CoreModule.addListener("glasses_not_ready", (_event: GlassesNotReadyEvent) => {
      setShowGlassesBooting(true)
    })
    return () => {
      sub.remove()
    }
  }, [])

  focusEffectPreventBack()

  const handleGoBack = useCallback(() => {
    clearPairingTimeout()
    goBack()
  }, [clearPairingTimeout, goBack])

  const handlePairFailure = useCallback(
    (error: string) => {
      clearPairingTimeout()
      CoreModule.forget()
      if (error === "errors:pairNeedDisconnect") {
        replace("/pairing/unpair-even", {deviceModel: deviceModel})
        return
      }
      replace("/pairing/failure", {error: error, deviceModel: deviceModel})
    },
    [clearPairingTimeout, replace, deviceModel],
  )

  useEffect(() => {
    let sub = CoreModule.addListener("pair_failure", (event: PairFailureEvent) => {
      handlePairFailure(event.error)
    })
    return () => {
      sub.remove()
    }
  }, [handlePairFailure])

  useEffect(() => {
    glassesFullyBootedRef.current = glassesFullyBooted
  }, [glassesFullyBooted])

  useEffect(() => {
    showGlassesBootingRef.current = showGlassesBooting
  }, [showGlassesBooting])

  useEffect(() => {
    hasSubmittedTimeoutIncidentRef.current = false

    timerRef.current = setTimeout(() => {
      if (!glassesFullyBootedRef.current && !hasSubmittedTimeoutIncidentRef.current) {
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
      }
    }, 35_000)

    return () => {
      clearPairingTimeout()
    }
  }, [clearPairingTimeout, deviceModel, deviceName])

  useEffect(() => {
    if (!glassesFullyBooted) return
    if (hasNavigatedRef.current) return
    hasNavigatedRef.current = true
    clearPairingTimeout()
    setTimeout(() => {
      replace("/pairing/success", {deviceModel: deviceModel})
    }, 1000)
  }, [clearPairingTimeout, glassesFullyBooted, replace, deviceModel])

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
