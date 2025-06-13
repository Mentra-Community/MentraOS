// SelectGlassesBluetoothScreen.tsx

import React, {useEffect, useMemo, useRef, useState, useCallback} from "react"
import {View, StyleSheet, TouchableOpacity, ScrollView, Image, Platform, Alert, ViewStyle, BackHandler} from "react-native"
import {useNavigation, useRoute, useFocusEffect} from "@react-navigation/native" // <<--- import useRoute
import Icon from "react-native-vector-icons/FontAwesome"
import {useStatus} from "@/contexts/AugmentOSStatusProvider"
import coreCommunicator from "@/bridge/CoreCommunicator"
import {MOCK_CONNECTION, SETTINGS_KEYS} from "@/consts"
import {NavigationProps} from "@/components/misc/types"
import {getGlassesImage} from "@/utils/getGlassesImage"
import PairingDeviceInfo from "@/components/misc/PairingDeviceInfo"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {useSearchResults} from "@/contexts/SearchResultsContext"
import {requestFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import showAlert from "@/utils/AlertUtils"
import {router, useLocalSearchParams} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import {Header, Screen, Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

export default function SelectGlassesBluetoothScreen() {
  const {status} = useStatus()
  const navigation = useNavigation<NavigationProps>()
  const {searchResults, setSearchResults} = useSearchResults()
  const {glassesModelName}: {glassesModelName: string} = useLocalSearchParams()
  const {theme, themed} = useAppTheme()
  const {goBack, push} = useNavigationHistory()
  // Create a ref to track the current state of searchResults
  const searchResultsRef = useRef<string[]>(searchResults)

  // Keep the ref updated whenever searchResults changes
  useEffect(() => {
    searchResultsRef.current = searchResults
  }, [searchResults])

  // Shared function to handle the forget glasses logic
  const handleForgetGlasses = useCallback(async () => {
    await coreCommunicator.sendDisconnectWearable()
    await coreCommunicator.sendForgetSmartGlasses()
    router.replace('/pairing/select-glasses-model')
  }, [])

  // Handle Android hardware back button
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        handleForgetGlasses()
        return true // Prevent default back action
      }

      const backHandler = BackHandler.addEventListener('hardwareBackPress', onBackPress)
      return () => backHandler.remove()
    }, [handleForgetGlasses])
  )

  useEffect(() => {
    const handleSearchResult = ({modelName, deviceName}: {modelName: string; deviceName: string}) => {
      // console.log("GOT SOME SEARCH RESULTS:");
      // console.log("ModelName: " + modelName);
      // console.log("DeviceName: " + deviceName);

      if (deviceName === "NOTREQUIREDSKIP") {
        console.log("SKIPPING")

        // Quick hack // bugfix => we get NOTREQUIREDSKIP twice in some cases, so just stop after the initial one
        GlobalEventEmitter.removeListener("COMPATIBLE_GLASSES_SEARCH_RESULT", handleSearchResult)

        triggerGlassesPairingGuide(glassesModelName as string, "")
        return
      }

      setSearchResults(prevResults => {
        if (!prevResults.includes(deviceName)) {
          return [...prevResults, deviceName]
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
              onPress: () => router.back(), // Navigate back if user chooses "No"
              style: "cancel",
            },
            {
              text: "Yes",
              onPress: () => coreCommunicator.sendSearchForCompatibleDeviceNames(glassesModelName), // Retry search
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

      coreCommunicator.sendSearchForCompatibleDeviceNames(glassesModelName)
      // todo: remove this once we figure out why it's not working w/o it (ios / core communicator isn't fully initialized or something)
      setTimeout(() => {
        coreCommunicator.sendSearchForCompatibleDeviceNames(glassesModelName)
      }, 1000)
    }

    initializeAndSearchForDevices()
  }, [glassesModelName])

  useEffect(() => {
    // If puck gets d/c'd here, return to home
    if (!status.core_info.puck_connected) {
      router.navigate("/")
    }

    // If pairing successful, return to home
    if (status.core_info.puck_connected && status.glasses_info?.model_name) {
      router.navigate("/")
    }
  }, [status])

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

    // update the preferredmic to be the phone mic:
    coreCommunicator.sendSetPreferredMic("phone")

    // All permissions granted, proceed with connecting to the wearable
    setTimeout(() => {
      // give some time to show the loader (otherwise it's a bit jarring)
      coreCommunicator.sendConnectWearable(glassesModelName, deviceName)
    }, 2000)
    router.push({
      pathname: "/pairing/guide",
      params: {
        glassesModelName: glassesModelName,
      },
    })
  }

  // Removed hardcoded theme2 object - using semantic theme colors instead

  const glassesImage = useMemo(() => getGlassesImage(glassesModelName), [glassesModelName])

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.md}} safeAreaEdges={["bottom"]}>
      <Header titleTx="pairing:scanningForGlasses" leftIcon="caretLeft" onLeftPress={handleForgetGlasses} />
      <View style={styles.contentContainer}>
        <PairingDeviceInfo glassesModelName={glassesModelName} />
      </View>
      <ScrollView
        style={{marginBottom: 20, marginTop: 10, marginRight: -theme.spacing.md, paddingRight: theme.spacing.md}}>
        {/* DISPLAY LIST OF BLUETOOTH SEARCH RESULTS */}
        {searchResults && searchResults.length > 0 && (
          <>
            {searchResults.map((deviceName, index) => (
              <TouchableOpacity
                key={index}
                style={themed($settingItem)}
                onPress={() => {
                  triggerGlassesPairingGuide(glassesModelName, deviceName)
                }}>
                <Image source={glassesImage} style={styles.glassesImage} />
                <View style={styles.settingTextContainer}>
                  <Text
                    text={deviceName}
                    style={[
                      styles.label,
                      {
                        color: theme.colors.text,
                      },
                    ]} />
                </View>
                <Icon name="angle-right" size={24} color={theme.colors.text} />
              </TouchableOpacity>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

const $settingItem: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  // Increased padding to give it a "bigger" look
  paddingVertical: 25,
  paddingHorizontal: 15,

  // Larger margin to separate each card
  marginVertical: 8,

  // Rounded corners
  borderRadius: 10,
  borderWidth: 1,

  // More subtle shadow for iOS
  shadowColor: "#000",
  shadowOpacity: 0.08,
  shadowRadius: 3,
  shadowOffset: {width: 0, height: 1},

  // More subtle elevation for Android
  elevation: 2,
  backgroundColor: colors.background,
})

const styles = StyleSheet.create({
  contentContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20, // Consistent spacing at the top
    overflow: "hidden", // Prevent content from creating visual lines
  },
  titleContainer: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    marginHorizontal: -20,
    marginTop: -20,
    marginBottom: 10,
  },
  // Removed hardcoded theme colors - using dynamic styling
  // titleContainerDark and titleContainerLight removed
  title: {
    fontSize: 24,
    fontWeight: "bold",
    textAlign: "left",
    marginBottom: 5,
    // color moved to dynamic styling
  },
  // Removed hardcoded theme colors - using dynamic styling
  // darkBackground, lightBackground, darkText, lightText, darkSubtext, lightSubtext, darkIcon, lightIcon removed
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
  },
  backButtonText: {
    marginLeft: 10,
    fontSize: 18,
    fontWeight: "bold",
  },
  settingTextContainer: {
    flex: 1,
    paddingHorizontal: 10,
  },
  label: {
    fontSize: 18, // bigger text size
    fontWeight: "600",
    flexWrap: "wrap",
  },
  value: {
    fontSize: 12,
    marginTop: 5,
    flexWrap: "wrap",
  },
  headerContainer: {
    paddingVertical: 15,
    paddingHorizontal: 15,
    borderBottomWidth: 1,
    // backgroundColor and borderBottomColor moved to dynamic styling
  },
  header: {
    fontSize: 24,
    fontWeight: "600",
    // color moved to dynamic styling
  },
  /**
   * BIGGER, SEXIER IMAGES
   */
  glassesImage: {
    width: 80, // bigger width
    height: 50, // bigger height
    resizeMode: "contain",
    marginRight: 10,
  },
})
