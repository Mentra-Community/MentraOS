import {useRoute} from "@react-navigation/native"
import CoreModule, {PairFailureEvent, GlassesNotReadyEvent} from "core"
import {useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {Button} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"

export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationHistory()
  const route = useRoute()
  const {deviceModel, deviceName} = route.params as {deviceModel: string; deviceName?: string}
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failureErrorRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasAlertShownRef = useRef(false)
  const hasNavigatedRef = useRef(false)
  const glassesFullyBooted = useGlassesStore((state) => state.fullyBooted)
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)

  useEffect(() => {
    let sub = CoreModule.addListener("glasses_not_ready", (_event: GlassesNotReadyEvent) => {
      setShowGlassesBooting(true)
    })
    return () => {
      sub.remove()
    }
  }, [])

  focusEffectPreventBack()

  const handlePairFailure = (error: string) => {
    CoreModule.forget()
    replace("/pairing/failure", {error: error, deviceModel: deviceModel})
  }

  useEffect(() => {
    let sub = CoreModule.addListener("pair_failure", (event: PairFailureEvent) => {
      handlePairFailure(event.error)
    })
    return () => {
      sub.remove()
    }
  }, [])

  useEffect(() => {
    hasAlertShownRef.current = false

    timerRef.current = setTimeout(() => {
      if (!glassesFullyBooted && !hasAlertShownRef.current) {
        hasAlertShownRef.current = true
      }
    }, 30000)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (failureErrorRef.current) clearTimeout(failureErrorRef.current)
    }
  }, [])

  useEffect(() => {
    if (!glassesFullyBooted) return
    if (hasNavigatedRef.current) return
    hasNavigatedRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    if (failureErrorRef.current) clearTimeout(failureErrorRef.current)
    setTimeout(() => {
      replace("/pairing/success", {deviceModel: deviceModel})
    }, 1000)
  }, [glassesFullyBooted, replace, deviceModel])

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header leftIcon="chevron-left" onLeftPress={goBack} />
      <View className="flex-1">
        <View className="flex-1 justify-center">
          <GlassesPairingLoader
            deviceModel={deviceModel}
            deviceName={deviceName}
            isBooting={showGlassesBooting}
            onCancel={goBack}
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
