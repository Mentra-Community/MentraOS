import CoreModule, {type Device} from "@mentra/bluetooth-sdk"
import {useLocalSearchParams} from "expo-router"
import {useEffect, useState} from "react"
import {ActivityIndicator, Image, Platform, ScrollView, TouchableOpacity, View} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Button, Header, Screen, Text} from "@/components/ignite"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import Divider from "@/components/ui/Divider"
import {Group} from "@/components/ui/Group"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {getGlassesOpenImage} from "@/utils/getGlassesImage"
import {useCoreStore} from "@/stores/core"
import GlassView from "@/components/ui/GlassView"
import {useNavigationStore} from "@/stores/navigation"

export default function SelectGlassesBluetoothScreen() {
  const {deviceModel}: {deviceModel: string} = useLocalSearchParams()
  const {theme} = useAppTheme()
  const {goBack, replace} = useNavigationStore.getState()
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const searchResults = useCoreStore((state) => state.searchResults)
  const [rememberedSearchResults, setRememberedSearchResults] = useState<Device[]>(searchResults)

  // useFocusEffect(
  //   useCallback(() => {
  //     setSearchResults([])
  //   }, [setSearchResults]),
  // )

  focusEffectPreventBack((event) => {
    // Skip cleanup when navigating forward — only run on actual back navigation.
    if (event && event.actionType !== "GO_BACK" && event.actionType !== "POP") {
      return
    }
    CoreModule.disconnectController()
    CoreModule.forgetController()
    goBack()
  }, true)

  useEffect(() => {
    const skipDevice = searchResults.find((result) => result.name === "NOTREQUIREDSKIP")
    if (skipDevice) {
      triggerGlassesPairingGuide(skipDevice)
      return
    }
  }, [searchResults])

  useEffect(() => {
    const initializeAndSearchForDevices = async () => {
      try {
        await CoreModule.startScan({model: deviceModel})
      } catch (error) {
        console.error("Failed to start controller scan:", error)
      }
    }

    void initializeAndSearchForDevices()
  }, [])

  const triggerGlassesPairingGuide = async (device: Device) => {
    if (Platform.OS === "android") {
      const hasLocationPermission = await requestFeaturePermissions(PermissionFeatures.LOCATION)

      if (!hasLocationPermission) {
        showAlert(
          "Location Permission Required",
          "Location permission is required to scan for and connect to smart glasses on Android. This is a requirement of the Android Bluetooth system.",
          [{text: "OK"}],
        )
        return
      }
    }

    const hasMicPermission = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)

    if (!hasMicPermission) {
      showAlert(
        "Microphone Permission Required",
        "Microphone permission is required to connect to smart glasses. Voice control and audio features are essential for the AR experience.",
        [{text: "OK"}],
      )
      return
    }

    await startPairing(device)
  }

  const startPairing = async (device: Device) => {
    setTimeout(() => {
      CoreModule.connect(device).catch((error) => {
        console.error("Failed to connect to controller:", error)
      })
    }, 2000)
    replace("/pairing/loading", {deviceModel: device.model, deviceName: device.name})
  }

  const filterDeviceName = (deviceName: string) => {
    let newName = deviceName.replace("MENTRA_LIVE_BLE_", "")
    newName = newName.replace("MENTRA_LIVE_BT_", "")
    newName = newName.replace("Mentra_Live_", "")
    newName = newName.replace("MENTRA_LIVE_", "")
    newName = newName.replace("MENTRA_DISPLAY_", "")
    return newName
  }

  // remember the search results to ensure consistent ordering:
  useEffect(() => {
    setRememberedSearchResults((prev) => {
      const combined = [...prev]
      for (const result of searchResults) {
        if (!combined.some((r) => r.id === result.id)) {
          combined.push(result)
        }
      }
      return combined
    })
  }, [searchResults])

  const visibleResults = rememberedSearchResults.filter((r) => r.model === deviceModel)

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header leftIcon="chevron-left" onLeftPress={goBack} RightActionComponent={<MentraLogoStandalone />} />
      <View className="flex-1 justify-center">
        <GlassView className="gap-6 rounded-3xl bg-primary-foreground p-6">
          <Image source={getGlassesOpenImage(deviceModel)} className="h-[90px] w-full" resizeMode="contain" />
          <Text
            className="text-center text-xl font-semibold text-text-dim"
            text={translate("pairing:scanningForGlassesModel", {model: deviceModel})}
          />

          {visibleResults.length === 0 ? (
            <View className="justify-center min-h-20 py-4">
              <ActivityIndicator size="large" color={theme.colors.foreground} />
            </View>
          ) : (
            <ScrollView className="max-h-[300px] -mr-4 pr-4" contentContainerClassName="my-4">
              <Group>
                {visibleResults.map((res: Device) => {
                  let deviceName = filterDeviceName(res.name)
                  return (
                    <View key={res.id} className="flex-row items-center justify-between px-4 py-3 bg-primary-foreground">
                      <TouchableOpacity
                        className="flex-1"
                        onPress={() => triggerGlassesPairingGuide(res)}>
                        <View className="flex-1 px-2.5 flex-col">
                          <Text text={deviceModel} className="flex-wrap text-sm font-semibold" numberOfLines={2} />
                          <Text text={deviceName} className="text-xs text-muted-foreground" numberOfLines={1} />
                        </View>
                      </TouchableOpacity>
                      <Icon name="chevron-right" size={24} color={theme.colors.text} />
                    </View>
                  )
                })}
              </Group>
            </ScrollView>
          )}
          <Divider />
          <View className="flex-row justify-end">
            <Button preset="primary" compact tx="common:cancel" onPress={() => goBack()} className="min-w-[100px]" />
          </View>
        </GlassView>
      </View>
      <Button
        preset="secondary"
        tx="pairing:needMoreHelp"
        onPress={() => setShowTroubleshootingModal(true)}
        className="w-full"
      />
      <GlassesTroubleshootingModal
        isVisible={showTroubleshootingModal}
        onClose={() => setShowTroubleshootingModal(false)}
        deviceModel={deviceModel}
      />
    </Screen>
  )
}
