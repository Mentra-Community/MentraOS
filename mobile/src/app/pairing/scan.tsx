import {useFocusEffect} from "@react-navigation/native"
import CoreModule from "core"
import {useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useRef, useState} from "react"
import {
  ActivityIndicator,
  BackHandler,
  Image,
  ImageStyle,
  Platform,
  ScrollView,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native"
import {useSharedValue, withDelay, withTiming} from "react-native-reanimated"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Button, Header, Screen, Text} from "@/components/ignite"
import GlassesTroubleshootingModal from "@/components/misc/GlassesTroubleshootingModal"
import Divider from "@/components/ui/Divider"
import {Group} from "@/components/ui/Group"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {MOCK_CONNECTION} from "@/utils/Constants"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {getGlassesOpenImage} from "@/utils/getGlassesImage"
import {useAppTheme} from "@/utils/useAppTheme"

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
  const {theme, themed} = useAppTheme()
  const {goBack, replace, clearHistoryAndGoHome} = useNavigationHistory()
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  // Create a ref to track the current state of searchResults
  const searchResultsRef = useRef<SearchResultDevice[]>(searchResults)
  const glassesConnected = useGlassesStore(state => state.connected)

  const scrollViewOpacity = useSharedValue(0)
  useEffect(() => {
    scrollViewOpacity.value = withDelay(2000, withTiming(1, {duration: 1000}))
  }, [])

  // Keep the ref updated whenever searchResults changes
  useEffect(() => {
    searchResultsRef.current = searchResults
  }, [searchResults])

  // Clear search results when screen comes into focus to prevent stale data
  useFocusEffect(
    useCallback(() => {
      setSearchResults([])
    }, [setSearchResults]),
  )

  // Handle Android hardware back button
  useEffect(() => {
    // Only handle on Android
    if (Platform.OS !== "android") return

    const onBackPress = () => {
      // Call our custom back handler
      goBack()
      // Return true to prevent default back behavior and stop propagation
      return true
    }

    // Use setTimeout to ensure our handler is registered after NavigationHistoryContext
    const timeout = setTimeout(() => {
      // Add the event listener - this will be on top of the stack
      const backHandler = BackHandler.addEventListener("hardwareBackPress", onBackPress)

      // Store the handler for cleanup
      backHandlerRef.current = backHandler
    }, 100)

    // Cleanup function
    return () => {
      clearTimeout(timeout)
      if (backHandlerRef.current) {
        backHandlerRef.current.remove()
        backHandlerRef.current = null
      }
    }
  }, [goBack])

  // Ref to store the back handler for cleanup
  const backHandlerRef = useRef<any>(null)

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
      // console.log("GOT SOME SEARCH RESULTS:");
      // console.log("ModelName: " + modelName);
      // console.log("DeviceName: " + deviceName);

      if (deviceName === "NOTREQUIREDSKIP") {
        console.log("SKIPPING")

        // Quick hack // bugfix => we get NOTREQUIREDSKIP twice in some cases, so just stop after the initial one
        GlobalEventEmitter.removeListener("COMPATIBLE_GLASSES_SEARCH_RESULT", handleSearchResult)

        triggerGlassesPairingGuide(glassesModelName as string, deviceName)
        return
      }

      setSearchResults(prevResults => {
        const isDuplicate = deviceAddress
          ? prevResults.some(device => device.deviceAddress === deviceAddress)
          : prevResults.some(device => device.deviceName === deviceName)

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
              onPress: () => goBack(), // Navigate back if user chooses "No"
              style: "cancel",
            },
            {
              text: "Yes",
              onPress: () => CoreModule.findCompatibleDevices(glassesModelName), // Retry search
            },
          ],
          {cancelable: false}, // Prevent closing the alert by tapping outside
        )
      }
    }

    if (!MOCK_CONNECTION) {
      GlobalEventEmitter.on("COMPATIBLE_GLASSES_SEARCH_RESULT", handleSearchResult)
      GlobalEventEmitter.on("COMPATIBLE_GLASSES_SEARCH_STOP", stopSearch)
    }

    return () => {
      if (!MOCK_CONNECTION) {
        GlobalEventEmitter.removeListener("COMPATIBLE_GLASSES_SEARCH_RESULT", handleSearchResult)
        GlobalEventEmitter.removeListener("COMPATIBLE_GLASSES_SEARCH_STOP", stopSearch)
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
      // on ios, we need to wait for the core communicator to be fully initialized and sending this twice is just the easiest way to do that
      // initializeAndSearchForDevices()
      setTimeout(() => {
        initializeAndSearchForDevices()
      }, 3000)
    } else {
      initializeAndSearchForDevices()
    }
  }, [])

  useEffect(() => {
    // If pairing successful, return to home
    if (glassesConnected) {
      clearHistoryAndGoHome()
    }
  }, [glassesConnected])

  const triggerGlassesPairingGuide = async (glassesModelName: string, deviceName: string) => {
    // On Android, we need to check both microphone and location permissions
    if (Platform.OS === "android") {
      // First check location permission, which is required for Bluetooth scanning on Android
      const hasLocationPermission = await requestFeaturePermissions(PermissionFeatures.LOCATION)

      if (!hasLocationPermission) {
        // Inform the user that location permission is required for Bluetooth scanning
        showAlert(
          "Location Permission Required",
          "Location permission is required to scan for and connect to smart glasses on Android. This is a requirement of the Android Bluetooth system.",
          [{text: "OK"}],
        )
        return // Stop the connection process
      }
    }

    // Next, check microphone permission for all platforms
    const hasMicPermission = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)

    // Only proceed if permission is granted
    if (!hasMicPermission) {
      // Inform the user that microphone permission is required
      showAlert(
        "Microphone Permission Required",
        "Microphone permission is required to connect to smart glasses. Voice control and audio features are essential for the AR experience.",
        [{text: "OK"}],
      )
      return // Stop the connection process
    }

    // All permissions granted, proceed with connecting to the wearable
    // Note: preferred_mic will use default "auto" - user can change in settings if needed
    // (Previously set here, but moved because default_wearable wasn't set yet for the indexer)
    setTimeout(() => {
      CoreModule.connectByName(deviceName)
    }, 2000)
    replace("/pairing/loading", {glassesModelName: glassesModelName, deviceName: deviceName})
  }

  const filterDeviceName = (deviceName: string) => {
    // filter out MENTRA_LIVE from the device name:
    let newName = deviceName.replace("MENTRA_LIVE_BLE_", "")
    newName = newName.replace("MENTRA_LIVE_BT_", "")
    newName = newName.replace("Mentra_Live_", "")
    newName = newName.replace("MENTRA_LIVE_", "")
    return newName
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header leftIcon="chevron-left" onLeftPress={goBack} RightActionComponent={<MentraLogoStandalone />} />
      <View style={themed($container)}>
        <View style={themed($centerWrapper)}>
          <View style={themed($contentContainer)}>
            <Image source={getGlassesOpenImage(glassesModelName)} style={themed($glassesImage)} />
            <Text
              style={themed($scanningText)}
              text={translate("pairing:scanningForGlassesModel", {model: glassesModelName})}
            />

            {!searchResults || searchResults.length === 0 ? (
              <View style={{justifyContent: "center", flex: 1, paddingVertical: theme.spacing.s4}}>
                <ActivityIndicator size="large" color={theme.colors.text} />
              </View>
            ) : (
              <ScrollView style={{maxHeight: 300, paddingRight: theme.spacing.s6, marginRight: -theme.spacing.s6}}>
                <Group>
                  {searchResults.map((device, index) => (
                    <TouchableOpacity
                      key={index}
                      style={themed($settingItem)}
                      onPress={() => triggerGlassesPairingGuide(device.deviceMode, device.deviceName)}>
                      <View style={themed($settingsTextContainer)}>
                        <Text
                          text={`${glassesModelName} - ${filterDeviceName(device.deviceName)}`}
                          style={themed($label)}
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
            <View style={themed($buttonContainer)}>
              <Button
                preset="alternate"
                compact
                tx="common:cancel"
                onPress={() => goBack()}
                style={themed($cancelButton)}
              />
            </View>
          </View>
        </View>
        <Button
          preset="secondary"
          tx="pairing:needMoreHelp"
          onPress={() => setShowTroubleshootingModal(true)}
          style={themed($helpButton)}
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

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  paddingBottom: spacing.s6,
})

const $centerWrapper: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
})

const $contentContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  // height: 520,
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s6,
  borderWidth: 1,
  borderColor: colors.border,
  padding: spacing.s6,
  gap: spacing.s6,
  // paddingBottom: spacing.s16,
})

const $buttonContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "flex-end",
})

const $cancelButton: ThemedStyle<ViewStyle> = () => ({
  minWidth: 100,
})

const $helpButton: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})

const $settingItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s4,
  backgroundColor: colors.background,
  height: 50,
})

const $scanningText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 20,
  fontWeight: "600",
  color: colors.textDim,
  textAlign: "center",
})

const $glassesImage: ThemedStyle<ImageStyle> = () => ({
  width: "100%",
  resizeMode: "contain",
  height: 90,
})

const $label: ThemedStyle<TextStyle> = () => ({
  fontSize: 14,
  fontWeight: "600",
  flexWrap: "wrap",
  // marginTop: 5,
})

const $settingsTextContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  paddingHorizontal: 10,
})
