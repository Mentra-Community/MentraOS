import {useFocusEffect} from "@react-navigation/native"
import CoreModule from "core"
import {useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useRef, useState} from "react"
import {ActivityIndicator, BackHandler, Image, Platform, ScrollView, TouchableOpacity, View} from "react-native"

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Button, Header, Screen, Text} from "@/components/ignite"
import GlassesTroubleshootingModal from "@/components/misc/GlassesTroubleshootingModal"
import Divider from "@/components/ui/Divider"
import {Group} from "@/components/ui/Group"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import showAlert from "@/utils/AlertUtils"
import {MOCK_CONNECTION} from "@/utils/Constants"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {getGlassesOpenImage} from "@/utils/getGlassesImage"
import { SETTINGS, useSetting } from "@/stores/settings"

class SearchResultDevice {
  deviceMode: string
  deviceName: string
  deviceAddress: string
  constructor(deviceMode: string, deviceName: string, deviceAddress: string) {
    this.deviceMode = deviceMode
    this.deviceName = deviceName
    this.deviceAddress = deviceAddress
  }
}

export default function SelectGlassesBluetoothScreen() {
  const [searchResults, setSearchResults] = useState<SearchResultDevice[]>([])
  const {glassesModelName}: {glassesModelName: string} = useLocalSearchParams()
  const {theme} = useAppTheme()
  const {goBack, replace, clearHistoryAndGoHome, push, pushUnder} = useNavigationHistory()
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const searchResultsRef = useRef<SearchResultDevice[]>(searchResults)
  const btcConnected = useGlassesStore((state) => state.btcConnected)
  const backHandlerRef = useRef<any>(null)
  const [_deviceName, setDeviceName] = useSetting(SETTINGS.device_name.key)

  useEffect(() => {
    searchResultsRef.current = searchResults
  }, [searchResults])

  useFocusEffect(
    useCallback(() => {
      setSearchResults([])
    }, [setSearchResults]),
  )

  useEffect(() => {
    if (Platform.OS !== "android") return

    const onBackPress = () => {
      goBack()
      return true
    }

    const timeout = setTimeout(() => {
      const backHandler = BackHandler.addEventListener("hardwareBackPress", onBackPress)
      backHandlerRef.current = backHandler
    }, 100)

    return () => {
      clearTimeout(timeout)
      if (backHandlerRef.current) {
        backHandlerRef.current.remove()
        backHandlerRef.current = null
      }
    }
  }, [goBack])

  useEffect(() => {
    const handleSearchResult = ({
      modelName,
      deviceName,
      deviceAddress,
    }: {
      modelName: string
      deviceName: string
      deviceAddress: string
    }) => {
      if (deviceName === "NOTREQUIREDSKIP") {
        console.log("SKIPPING")
        GlobalEventEmitter.removeListener("compatible_glasses_search_result", handleSearchResult)
        triggerGlassesPairingGuide(glassesModelName as string, deviceName)
        return
      }

      setSearchResults((prevResults) => {
        const isDuplicate = deviceAddress
          ? prevResults.some((device) => device.deviceAddress === deviceAddress)
          : prevResults.some((device) => device.deviceName === deviceName)

        if (!isDuplicate) {
          const newDevice = new SearchResultDevice(modelName, deviceName, deviceAddress)
          return [...prevResults, newDevice]
        }
        return prevResults
      })
    }

    const stopSearch = ({modelName}: {modelName: string}) => {
      console.log("SEARCH RESULTS:")
      console.log(JSON.stringify(searchResults))
      if (searchResultsRef.current.length === 0) {
        showAlert(
          "No " + modelName + " found",
          "Retry search?",
          [
            {
              text: "No",
              onPress: () => goBack(),
              style: "cancel",
            },
            {
              text: "Yes",
              onPress: () => CoreModule.findCompatibleDevices(glassesModelName),
            },
          ],
          {cancelable: false},
        )
      }
    }

    if (!MOCK_CONNECTION) {
      GlobalEventEmitter.on("compatible_glasses_search_result", handleSearchResult)
      GlobalEventEmitter.on("compatible_glasses_search_stop", stopSearch)
    }

    return () => {
      if (!MOCK_CONNECTION) {
        GlobalEventEmitter.removeListener("compatible_glasses_search_result", handleSearchResult)
        GlobalEventEmitter.removeListener("compatible_glasses_search_stop", stopSearch)
      }
    }
  }, [])

  useEffect(() => {
    const initializeAndSearchForDevices = async () => {
      console.log("Searching for compatible devices for: ", glassesModelName)
      setSearchResults([])
      CoreModule.findCompatibleDevices(glassesModelName)
    }

    if (Platform.OS === "ios") {
      setTimeout(() => {
        initializeAndSearchForDevices()
      }, 3000)
    } else {
      initializeAndSearchForDevices()
    }
  }, [])

  // useEffect(() => {
  //   if (glassesConnected) {
  //     clearHistoryAndGoHome()
  //   }
  // }, [glassesConnected])

  const triggerGlassesPairingGuide = async (glassesModelName: string, deviceName: string) => {
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

    startPairing(glassesModelName, deviceName)
  }

  const startPairing = async (glassesModelName: string, deviceName: string) => {
    
    const deviceTypesWithBtClassic = [DeviceTypes.LIVE]
    if (
      Platform.OS === "android" ||
      btcConnected ||
      !deviceTypesWithBtClassic.includes(glassesModelName as DeviceTypes)
    ) {
      setTimeout(() => {
        CoreModule.connectByName(deviceName)
      }, 2000)
      replace("/pairing/loading", {glassesModelName: glassesModelName, deviceName: deviceName})
      return
    }

    // CoreModule.updateSettings({"device_name": deviceName})
    setDeviceName(deviceName)
    // pair bt classic first:
    push("/pairing/btclassic")
    pushUnder("/pairing/loading", {glassesModelName: glassesModelName, deviceName: deviceName})
  }

  const filterDeviceName = (deviceName: string) => {
    let newName = deviceName.replace("MENTRA_LIVE_BLE_", "")
    newName = newName.replace("MENTRA_LIVE_BT_", "")
    newName = newName.replace("Mentra_Live_", "")
    newName = newName.replace("MENTRA_LIVE_", "")
    return newName
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header leftIcon="chevron-left" onLeftPress={goBack} RightActionComponent={<MentraLogoStandalone />} />
      <View className="flex-1 pb-6">
        <View className="flex-1 justify-center">
          <View className="gap-6 rounded-3xl bg-primary-foreground p-6">
            <Image source={getGlassesOpenImage(glassesModelName)} className="h-[90px] w-full" resizeMode="contain" />
            <Text
              className="text-center text-xl font-semibold text-text-dim"
              text={translate("pairing:scanningForGlassesModel", {model: glassesModelName})}
            />

            {!searchResults || searchResults.length === 0 ? (
              <View className="flex-1 justify-center py-4">
                <ActivityIndicator size="large" color={theme.colors.text} />
              </View>
            ) : (
              <ScrollView className="-mr-6 max-h-[300px] pr-6">
                <Group>
                  {searchResults.map((device, index) => (
                    <TouchableOpacity
                      key={index}
                      className="h-[50px] flex-row items-center justify-between bg-background px-4 py-3"
                      onPress={() => triggerGlassesPairingGuide(device.deviceMode, device.deviceName)}>
                      <View className="flex-1 px-2.5">
                        <Text
                          text={`${glassesModelName} - ${filterDeviceName(device.deviceName)}`}
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
              <Button
                preset="alternate"
                compact
                tx="common:cancel"
                onPress={() => goBack()}
                className="min-w-[100px]"
              />
            </View>
          </View>
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
        glassesModelName={glassesModelName}
      />
    </Screen>
  )
}
