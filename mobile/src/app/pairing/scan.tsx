import CoreModule, {DeviceSearchResult} from "core"
import {useLocalSearchParams} from "expo-router"
import {useEffect, useState} from "react"
import {ActivityIndicator, Image, Platform, ScrollView, TouchableOpacity, View} from "react-native"

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Button, Header, Screen, Text} from "@/components/ignite"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import Divider from "@/components/ui/Divider"
import {Group} from "@/components/ui/Group"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import showAlert from "@/utils/AlertUtils"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {getGlassesOpenImage} from "@/utils/getGlassesImage"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useCoreStore} from "@/stores/core"

export default function SelectGlassesBluetoothScreen() {
  const {deviceModel}: {deviceModel: string} = useLocalSearchParams()
  const {theme} = useAppTheme()
  const {goBack, replace, pushUnder} = useNavigationHistory()
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const btcConnected = useGlassesStore((state) => state.btcConnected)
  const [_deviceName, setDeviceName] = useSetting(SETTINGS.device_name.key)
  const searchResults = useCoreStore((state) => state.searchResults)
  const [rememberedSearchResults, setRememberedSearchResults] = useState<DeviceSearchResult[]>(searchResults)

  // useFocusEffect(
  //   useCallback(() => {
  //     setSearchResults([])
  //   }, [setSearchResults]),
  // )

  // focusEffectPreventBack()

  useEffect(() => {
    if (searchResults.some((result) => result.deviceName === "NOTREQUIREDSKIP")) {
      triggerGlassesPairingGuide(deviceModel, "NOTREQUIREDSKIP")
      return
    }
  }, [searchResults])

  useEffect(() => {
    const initializeAndSearchForDevices = async () => {
      CoreModule.findCompatibleDevices(deviceModel)
    }

    initializeAndSearchForDevices()
  }, [])

  const triggerGlassesPairingGuide = async (deviceModel: string, deviceName: string) => {
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

    startPairing(deviceModel, deviceName)
  }

  const startPairing = async (deviceModel: string, deviceName: string) => {
    const deviceTypesWithBtClassic = [DeviceTypes.LIVE]
    if (Platform.OS === "android" || btcConnected || !deviceTypesWithBtClassic.includes(deviceModel as DeviceTypes)) {
      setTimeout(() => {
        CoreModule.connectByName(deviceName)
      }, 2000)
      replace("/pairing/loading", {deviceModel: deviceModel, deviceName: deviceName})
      return
    }

    setDeviceName(deviceName)
    // pair bt classic first:
    replace("/pairing/btclassic")
    pushUnder("/pairing/loading", {deviceModel: deviceModel, deviceName: deviceName})
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
        if (!combined.some((r) => r.deviceAddress === result.deviceAddress && r.deviceName === result.deviceName)) {
          combined.push(result)
        }
      }
      return combined
    })
  }, [searchResults])

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header leftIcon="chevron-left" onLeftPress={goBack} RightActionComponent={<MentraLogoStandalone />} />
      <View className="flex-1 pt-[35%]">
        <View className="gap-6 rounded-3xl bg-primary-foreground p-6">
          <Image source={getGlassesOpenImage(deviceModel)} className="h-[90px] w-full" resizeMode="contain" />
          <Text
            className="text-center text-xl font-semibold text-text-dim"
            text={translate("pairing:scanningForGlassesModel", {model: deviceModel})}
          />

          {!rememberedSearchResults || rememberedSearchResults.length === 0 ? (
            <View className="flex-1 justify-center py-4">
              <ActivityIndicator size="large" color={theme.colors.foreground} />
            </View>
          ) : (
            <ScrollView className="max-h-[300px] -mr-4 pr-4">
              <Group>
                {rememberedSearchResults.map((res: DeviceSearchResult, index: number) => (
                  <TouchableOpacity
                    key={index}
                    className="h-[50px] flex-row items-center justify-between bg-background px-4 py-3"
                    onPress={() => triggerGlassesPairingGuide(res.deviceModel, res.deviceName)}>
                    <View className="flex-1 px-2.5">
                      <Text
                        text={`${deviceModel} - ${filterDeviceName(res.deviceName)}`}
                        className="flex-wrap text-sm font-semibold"
                        numberOfLines={2}
                      />
                    </View>
                    <Icon name="chevron-right" size={24} color={theme.colors.text} />
                  </TouchableOpacity>
                ))}
              </Group>
            </ScrollView>
          )}
          <Divider />
          <View className="flex-row justify-end">
            <Button preset="secondary" compact tx="common:cancel" onPress={() => goBack()} className="min-w-[100px]" />
          </View>
        </View>
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
