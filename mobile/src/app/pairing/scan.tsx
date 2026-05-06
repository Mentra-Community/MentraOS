import CoreModule, {DeviceSearchResult} from "core"
import {useFocusEffect, useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useState} from "react"
import {ActivityIndicator, Image, Platform, ScrollView, TouchableOpacity, View} from "react-native"

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Button, Header, Screen, Text} from "@/components/ignite"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import Divider from "@/components/ui/Divider"
import {Group} from "@/components/ui/Group"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import showAlert from "@/utils/AlertUtils"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {getGlassesOpenImage} from "@/utils/getGlassesImage"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useCoreStore} from "@/stores/core"
import GlassView from "@/components/ui/GlassView"

export default function SelectGlassesBluetoothScreen() {
  const {deviceModel}: {deviceModel: string} = useLocalSearchParams()
  const {theme} = useAppTheme()
  const {goBack, replace, pushUnder, push} = useNavigationHistory()
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const btcConnected = useGlassesStore((state) => state.btcConnected)
  const [_deviceName, setDeviceName] = useSetting(SETTINGS.device_name.key)
  const searchResults = useCoreStore((state) => state.searchResults)
  const [rememberedSearchResults, setRememberedSearchResults] = useState<DeviceSearchResult[]>(searchResults)

  // useFocusEffect(
  //   useCallback(() => {
  //     setRememberedSearchResults([])
  //   }, [setRememberedSearchResults]),
  // )

  focusEffectPreventBack((event) => {
    // Skip cleanup when navigating forward (e.g. replace() to btclassic) —
    // only run on actual back navigation.
    if (event && event.actionType !== "GO_BACK" && event.actionType !== "POP") {
      return
    }
    CoreModule.disconnect()
    CoreModule.forget()
    goBack()
  }, true)

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
      push("/pairing/loading", {deviceModel: deviceModel, deviceName: deviceName})
      // push("/pairing/success", {deviceModel: deviceModel})
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
        // if the device model is not our current device model, skip it:
        if (result.deviceModel !== deviceModel) {
          continue
        }
        if (!combined.some((r) => r.deviceAddress === result.deviceAddress && r.deviceName === result.deviceName)) {
          combined.push(result)
        }
      }
      return combined
    })
  }, [searchResults])

  const visibleResults = rememberedSearchResults.filter(
    (r) => r.deviceName !== "NOTREQUIREDSKIP" && r.deviceModel === deviceModel,
  )

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header leftIcon="chevron-left" onLeftPress={goBack} RightActionComponent={<MentraLogoStandalone />} />
      <View className="flex-1 justify-center">
        <GlassView className="gap-6 rounded-3xl p-6 bg-background" transparent={false}>
          <Image
            source={getGlassesOpenImage(deviceModel)}
            className="h-[90px] w-[156px] mx-auto"
            resizeMode="contain"
          />
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
                {visibleResults.map((res: DeviceSearchResult, index: number) => {
                  let deviceName = filterDeviceName(res.deviceName)

                  return (
                    <View className="flex-row items-center justify-between px-4 py-3 bg-primary-foreground/80">
                      <TouchableOpacity
                        key={index}
                        className="flex-1"
                        onPress={() => triggerGlassesPairingGuide(res.deviceModel, res.deviceName)}>
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
            <Button preset="alternate" compact tx="common:cancel" onPress={() => goBack()} className="min-w-[100px]" />
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
