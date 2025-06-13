import React, {useRef, useCallback, PropsWithChildren, useState, useEffect} from "react"
import {View, Animated, Platform, ViewStyle, ScrollView, TouchableOpacity} from "react-native"
import {useFocusEffect} from "@react-navigation/native"
import {Header, Screen} from "@/components/ignite"
import AppsActiveList from "@/components/misc/AppsActiveList"
import AppsInactiveList from "@/components/misc/AppsInactiveList"
import {useStatus} from "@/contexts/AugmentOSStatusProvider"
import {useAppStatus} from "@/contexts/AppStatusProvider"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import semver from "semver"
import Constants from "expo-constants"
import CloudConnection from "@/components/misc/CloudConnection"
import {loadSetting} from "@/utils/SettingsHelper"
import SensingDisabledWarning from "@/components/misc/SensingDisabledWarning"
import NonProdWarning from "@/components/misc/NonProdWarning"
import {spacing, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import MicIcon from "assets/icons/component/MicIcon"
import NotificationOn from "assets/icons/component/NotificationOn"
import {ConnectDeviceButton, ConnectedGlasses, DeviceToolbar} from "@/components/misc/ConnectedDeviceInfo"
import {Spacer} from "@/components/misc/Spacer"
import Divider from "@/components/misc/Divider"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import {router} from "expo-router"

interface AnimatedSectionProps extends PropsWithChildren {
  delay?: number
}

export default function Homepage() {
  const {appStatus} = useAppStatus()
  const {status} = useStatus()
  const [isSimulatedPuck, setIsSimulatedPuck] = React.useState(false)
  const [isCheckingVersion, setIsCheckingVersion] = useState(false)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [hasMissingPermissions, setHasMissingPermissions] = useState(false)

  const fadeAnim = useRef(new Animated.Value(0)).current
  const bellFadeAnim = useRef(new Animated.Value(0)).current
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
    return () => {}
  }, [status.core_info.cloud_connection_status])

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

      if (!localVer) {
        // console.error("Failed to get local version from env file")
        // Navigate to update screen with connection error
        // router.push({pathname: "/version-update", params: {
        //   connectionError: "true",
        // }})
        setIsCheckingVersion(false)
        return
      }

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

  // Check for missing permissions
  useEffect(() => {
    const checkPermissions = async () => {
      const hasCalendar = await checkFeaturePermissions(PermissionFeatures.CALENDAR)
      const hasNotifications = Platform.OS === "android" ? await checkFeaturePermissions(PermissionFeatures.READ_NOTIFICATIONS) : true
      
      const shouldShowBell = !hasCalendar || !hasNotifications
      setHasMissingPermissions(shouldShowBell)
      
      // Animate bell in if needed
      if (shouldShowBell) {
        Animated.timing(bellFadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start()
      }
    }
    
    checkPermissions()
  }, [])

  const handleBellPress = () => {
    router.push("/settings/privacy")
  }

  // Simple animated wrapper so we do not duplicate logic

  useFocusEffect(
    useCallback(() => {
      // Reset animations when screen is about to focus
      fadeAnim.setValue(0)

      // Start animations after a short delay
      const animationTimeout = setTimeout(() => {
        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ]).start()
      }, 50)

      return () => {
        clearTimeout(animationTimeout)
        fadeAnim.setValue(0)
      }
    }, [fadeAnim]),
  )

  return (
    <Screen preset="fixed" style={themed($screen)}>
      <Header
        leftTx="home:title"
        RightActionComponent={
          <View style={themed($headerRight)}>
            {hasMissingPermissions && (
              <Animated.View style={{ opacity: bellFadeAnim }}>
                <TouchableOpacity onPress={handleBellPress}>
                  <NotificationOn />
                </TouchableOpacity>
              </Animated.View>
            )}
            <MicIcon withBackground />
          </View>
        }
      />

      <ScrollView style={{marginRight: -theme.spacing.md, paddingRight: theme.spacing.md}}>
        {status.core_info.cloud_connection_status !== "CONNECTED" && <CloudConnection />}

        <SensingDisabledWarning />
        <NonProdWarning />

        <ConnectedGlasses showTitle={false} />
        <DeviceToolbar />
        <Spacer height={theme.spacing.md} />
        <ConnectDeviceButton />
        <Spacer height={theme.spacing.lg} />
        <Divider variant="full" />
        <Spacer height={theme.spacing.md} />

        <AppsActiveList />
        <Spacer height={spacing.xl} />
        <AppsInactiveList key={`apps-list-${appStatus.length}`} />
      </ScrollView>
    </Screen>
  )
}

const $screen: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.lg,
})

const $headerRight: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.sm,
})
