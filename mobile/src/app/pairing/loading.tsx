import {useRoute} from "@react-navigation/native"
import {toolkit} from "@mentra/engine"
import type {PairFailureEvent} from "@mentra/engine"
import {useCallback, useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {Button} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useToolkitSnapshot} from "@/hooks/useToolkitSnapshot"
import {useNavigationStore} from "@/stores/navigation"

export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationStore.getState()
  const route = useRoute()
  const {deviceModel, deviceName} = route.params as {deviceModel: string; deviceName?: string}
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const hasNavigatedRef = useRef(false)
  const glassesFullyBooted = useToolkitSnapshot(toolkit.pairing.readiness, (onChange) =>
    toolkit.pairing.onReadiness(onChange),
  ).fullyBooted
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)

  useEffect(() => {
    let unsub = toolkit.pairing.onGlassesNotReady(() => {
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
      // Clears the failed attempt; when a real pairing predates this attempt
      // (re-pair), it is preserved instead of forgotten.
      void toolkit.pairing.abandonAttempt().catch((cleanupError) => {
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
    let unsub = toolkit.pairing.onPairFailure((event: PairFailureEvent) => {
      handlePairFailure(event.error)
    })
    return () => {
      unsub()
    }
  }, [handlePairFailure])

  useEffect(() => {
    const controller = new AbortController()

    void toolkit.pairing.waitForReady({
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
