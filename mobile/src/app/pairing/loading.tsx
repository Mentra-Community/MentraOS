import {useRoute} from "@react-navigation/native"
import {waitForGlassesReady, toolkit} from "@mentra/island"
import type {PairFailureEvent, GlassesNotReadyEvent} from "@mentra/island"
import {useCallback, useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {Button} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {selectGlassesReady, useGlassesStore} from "@/stores/glasses"
import {useNavigationStore} from "@/stores/navigation"

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

  useEffect(() => {
    let unsub = toolkit.pairing.onGlassesNotReady((_event: GlassesNotReadyEvent) => {
      setShowGlassesBooting(true)
    })
    return () => {
      unsub()
    }
  }, [])

  focusEffectPreventBack()

  const handleGoBack = useCallback(() => {
    goBack()
  }, [goBack])

  const handlePairFailure = useCallback(
    (error: string) => {
      toolkit.glasses.forget()
      if (error === "errors:pairNeedDisconnect") {
        replace("/pairing/unpair-even", {deviceModel: deviceModel})
        return
      }
      replace("/pairing/failure", {error: error, deviceModel: deviceModel})
    },
    [replace, deviceModel],
  )

  useEffect(() => {
    let unsub = toolkit.pairing.onPairFailure((event: PairFailureEvent) => {
      handlePairFailure(event.error)
    })
    return () => {
      unsub()
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
      // Booted in time (or the screen unmounted) — nothing to report.
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
    if (!glassesFullyBooted) return
    if (hasNavigatedRef.current) return
    hasNavigatedRef.current = true
    setTimeout(() => {
      replace("/pairing/success", {deviceModel: deviceModel})
    }, 1000)
  }, [glassesFullyBooted, replace, deviceModel])

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
