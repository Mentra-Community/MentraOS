import {useRoute} from "@react-navigation/native"
import CoreModule from "core"
import {useEffect, useRef, useState} from "react"
import {ScrollView, TouchableOpacity, View} from "react-native"

import {Button, Icon, Text} from "@/components/ignite"
import {Header} from "@/components/ignite/Header"
import {PillButton} from "@/components/ignite/PillButton"
import {Screen} from "@/components/ignite/Screen"
import GlassesPairingLoader from "@/components/glasses/GlassesPairingLoader"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

export default function GlassesPairingLoadingScreen() {
  const {replace, goBack} = useNavigationHistory()
  const route = useRoute()
  const {modelName, deviceName} = route.params as {modelName: string; deviceName?: string}
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const [pairingInProgress, setPairingInProgress] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failureErrorRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasAlertShownRef = useRef(false)
  const glassesConnected = useGlassesStore((state) => state.connected)

  focusEffectPreventBack()

  const handlePairFailure = (error: string) => {
    CoreModule.forget()
    replace("/pairing/failure", {error: error, modelName: modelName})
  }

  useEffect(() => {
    GlobalEventEmitter.on("pair_failure", handlePairFailure)
    return () => {
      GlobalEventEmitter.off("pair_failure", handlePairFailure)
    }
  }, [])

  useEffect(() => {
    hasAlertShownRef.current = false
    setPairingInProgress(true)

    timerRef.current = setTimeout(() => {
      if (!glassesConnected && !hasAlertShownRef.current) {
        hasAlertShownRef.current = true
      }
    }, 30000)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (failureErrorRef.current) clearTimeout(failureErrorRef.current)
    }
  }, [])

  useEffect(() => {
    if (!glassesConnected) return
    if (timerRef.current) clearTimeout(timerRef.current)
    if (failureErrorRef.current) clearTimeout(failureErrorRef.current)
    replace("/pairing/success", {modelName: modelName})
  }, [glassesConnected, replace, modelName])

  if (pairingInProgress) {
    return (
      <Screen preset="fixed" safeAreaEdges={["bottom"]}>
        <Header leftIcon="chevron-left" onLeftPress={goBack} />
        <View className="flex-1 pb-6">
          <View className="flex-1 justify-center">
            <GlassesPairingLoader modelName={modelName} deviceName={deviceName} onCancel={goBack} />
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
          modelName={modelName}
        />
      </Screen>
    )
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header
        leftIcon="chevron-left"
        onLeftPress={goBack}
        RightActionComponent={
          <PillButton text="Help" variant="icon" onPress={() => setShowTroubleshootingModal(true)} className="mr-4" />
        }
      />
      <ScrollView className="flex-1">
        <View className="items-center justify-start">
          <TouchableOpacity
            className="mb-8 mt-5 flex-row items-center justify-center rounded-lg bg-blue-500 px-5 py-3 dark:bg-blue-500"
            onPress={() => setShowTroubleshootingModal(true)}>
            <Icon name="help-circle" size={16} color="#FFFFFF" style={{marginRight: 8}} />
            <Text className="text-base font-bold text-white" tx="pairing:needHelpPairing" />
          </TouchableOpacity>
        </View>
      </ScrollView>
      <GlassesTroubleshootingModal
        isVisible={showTroubleshootingModal}
        onClose={() => setShowTroubleshootingModal(false)}
        modelName={modelName}
      />
    </Screen>
  )
}
