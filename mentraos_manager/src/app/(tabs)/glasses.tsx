import React, {useRef, useCallback, PropsWithChildren, useState, useEffect} from "react"
import {View, Animated, Platform, ViewStyle, TextStyle, ScrollView} from "react-native"
import {useNavigation, useFocusEffect, useRoute} from "@react-navigation/native"
import type {NavigationProp} from "@react-navigation/native"
import {Header, Screen} from "@/components/ignite"
import {
  ConnectedDeviceInfo,
  ConnectDeviceButton,
  ConnectedGlasses,
  SplitDeviceInfo,
} from "@/components/misc/ConnectedDeviceInfo"
import ConnectedSimulatedGlassesInfo from "@/components/misc/ConnectedSimulatedGlassesInfo"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {useAppStatus} from "@/contexts/AppStatusProvider"
// import {ScrollView} from 'react-native-gesture-handler';
import BackendServerComms from "@/backend_comms/BackendServerComms"
import semver from "semver"
import Constants from "expo-constants"
import CloudConnection from "@/components/misc/CloudConnection"
import {loadSetting} from "@/utils/SettingsHelper"

import {SETTINGS_KEYS} from "@/consts"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import DeviceSettings from "@/components/glasses/DeviceSettings"
import {translate} from "@/i18n/translate"
import {Spacer} from "@/components/misc/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

interface AnimatedSectionProps extends PropsWithChildren {
  delay?: number
}

export default function Homepage() {
  const {appStatus} = useAppStatus()
  const {status} = useStatus()
  const [isSimulatedPuck, setIsSimulatedPuck] = React.useState(false)
  const [isCheckingVersion, setIsCheckingVersion] = useState(false)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [nonProdBackend, setNonProdBackend] = useState(false)

  const fadeAnim = useRef(new Animated.Value(0)).current
  const slideAnim = useRef(new Animated.Value(-50)).current
  const {themed, theme} = useAppTheme()

  // Reset loading state when connection status changes
  useEffect(() => {
    if (status.core_info.cloud_connection_status === "CONNECTED") {
      setIsInitialLoading(true)
      const timer = setTimeout(() => {
        setIsInitialLoading(false)
      }, 10000)
      return () => clearTimeout(timer)
    }
  }, [status.core_info.cloud_connection_status])

  const checkNonProdBackend = async () => {
    const url = await loadSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, null)
    setNonProdBackend(url && !url.includes("prod.mentra.glass") && !url.includes("global.mentra.glass"))
  }

  // Clear loading state if apps are loaded
  useEffect(() => {
    if (appStatus.length > 0) {
      setIsInitialLoading(false)
    }
  }, [appStatus.length])

  // Get local version from env file
  const getLocalVersion = () => {
    try {
      const version = Constants.expoConfig?.version
      console.log("Local version from env:", version)
      return version || null
    } catch (error) {
      console.error("Error getting local version:", error)
      return null
    }
  }

  // Check cloud version and navigate if needed
  const checkCloudVersion = async () => {
    if (isCheckingVersion) return
    setIsCheckingVersion(true)

    try {
      // Check if version checks are being ignored this session
      const ignoreCheck = await loadSetting("ignoreVersionCheck", false)
      if (ignoreCheck) {
        console.log("Version check skipped due to user preference")
        setIsCheckingVersion(false)
        return
      }

      const backendComms = BackendServerComms.getInstance()
      const localVer = getLocalVersion()

      // if (!localVer) {
      //   console.error("Failed to get local version from env file")
      //   // Navigate to update screen with connection error
      //   router.push({pathname: "/version-update", params: {
      //     connectionError: "true",
      //   }})
      //   setIsCheckingVersion(false)
      //   return
      // }

      // Call the endpoint to get cloud version
      await backendComms.restRequest("/apps/version", null, {
        onSuccess: data => {
          const cloudVer = data.version
          console.log(`Comparing local version (${localVer}) with cloud version (${cloudVer})`)

          // Compare versions using semver
          if (semver.lt(localVer, cloudVer)) {
            console.log("A new version is available. Navigate to update screen.")
            // Navigate to update screen with version mismatch
            // router.push({pathname: "/version-update", params: {
            //   localVersion: localVer,
            //   cloudVersion: cloudVer,
            // }})
          } else {
            console.log("Local version is up-to-date.")
            // Stay on homepage, no navigation needed
          }
          setIsCheckingVersion(false)
        },
        onFailure: errorCode => {
          console.error("Failed to fetch cloud version:", errorCode)
          // Navigate to update screen with connection error
          // router.push({pathname: "/version-update", params: {
          //   connectionError: "true",
          // }})
          setIsCheckingVersion(false)
        },
      })
      // console.log('Version check completed');
    } catch (error) {
      console.error("Error checking cloud version:", error)
      // Navigate to update screen with connection error
      // router.push({pathname: "/version-update", params: {
      //   connectionError: "true",
      // }})
      setIsCheckingVersion(false)
    }
  }

  // Check version once on mount
  useEffect(() => {
    if (Platform.OS == "android") {
      checkCloudVersion()
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      checkNonProdBackend()
      return () => {}
    }, []),
  )

  const formatGlassesTitle = (title: string) => title.replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase())
  let pageTitle

  if (status.core_info.default_wearable) {
    pageTitle = formatGlassesTitle(status.core_info.default_wearable)
  } else {
    pageTitle = translate("glasses:title")
  }

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.lg}}>
      <Header leftText={pageTitle} />
      <ScrollView style={{marginRight: -theme.spacing.md, paddingRight: theme.spacing.md}}>
        {status.core_info.cloud_connection_status !== "CONNECTED" && <CloudConnection />}

        {/* <View style={{flex: 1}}> */}
        {/* <ConnectedGlasses showTitle={true} /> */}
        {status.core_info.default_wearable && <ConnectedSimulatedGlassesInfo />}
        {/* <SplitDeviceInfo /> */}
        <ConnectedDeviceInfo />
        <Spacer height={theme.spacing.md} />
        <ConnectDeviceButton />
        {/* </View> */}

        <DeviceSettings />
      </ScrollView>
    </Screen>
  )
}
