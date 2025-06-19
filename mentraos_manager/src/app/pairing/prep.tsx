import React from "react"
import {View, Text, StyleSheet, Platform, Linking, ViewStyle, ScrollView} from "react-native"
import {useRoute} from "@react-navigation/native"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {getPairingGuide} from "@/utils/getPairingGuide"
import {PermissionsAndroid} from "react-native"
import {requestFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import {showAlert} from "@/utils/AlertUtils"
import {Button, Header} from "@/components/ignite"
import {router} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import {Screen} from "@/components/ignite/Screen"
import coreCommunicator from "@/bridge/CoreCommunicator"
import {translate} from "@/i18n"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

// Alert handling is now done directly in PermissionsUtils.tsx

// On Android, we'll check permissions once during the actual request process
// This simplifies our code and avoids making redundant permission requests

export default function PairingPrepScreen() {
  const {status} = useStatus()
  const route = useRoute()
  const {theme} = useAppTheme()
  const {glassesModelName} = route.params as {glassesModelName: string}
  const {goBack, push} = useNavigationHistory()
  // React.useEffect(() => {
  //   const unsubscribe = navigation.addListener('beforeRemove', (e) => {
  //     const actionType = e.data?.action?.type;
  //   });

  //   return unsubscribe;
  // }, [navigation]);

  // React.useEffect(() => {
  // }, [glassesModelName]);

  const advanceToPairing = async () => {
    if (glassesModelName == null || glassesModelName == "") {
      console.log("SOME WEIRD ERROR HERE")
      return
    }

    // Always request Bluetooth permissions - required for Android 14+ foreground service
    const needsBluetoothPermissions = true

    try {
      // Check for Android-specific permissions
      if (Platform.OS === "android") {
        // Android-specific Phone State permission - request for ALL glasses including simulated
        console.log("Requesting PHONE_STATE permission...")
        const phoneStateGranted = await requestFeaturePermissions(PermissionFeatures.PHONE_STATE)
        console.log("PHONE_STATE permission result:", phoneStateGranted)

        if (!phoneStateGranted) {
          // The specific alert for previously denied permission is already handled in requestFeaturePermissions
          // We just need to stop the flow here
          return
        }

        // Bluetooth permissions only for physical glasses
        if (needsBluetoothPermissions) {
          const bluetoothPermissions: any[] = []

          // Bluetooth permissions based on Android version
          if (typeof Platform.Version === "number" && Platform.Version >= 30 && Platform.Version < 31) {
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH)
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADMIN)
          }
          if (typeof Platform.Version === "number" && Platform.Version >= 31) {
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN)
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT)
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE)

            // Add NEARBY_DEVICES permission for Android 12+ (API 31+)
            if (PermissionsAndroid.PERMISSIONS.NEARBY_DEVICES) {
              bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_DEVICES)
            }
          }

          // Request Bluetooth permissions directly
          if (bluetoothPermissions.length > 0) {
            const results = await PermissionsAndroid.requestMultiple(bluetoothPermissions)
            const allGranted = Object.values(results).every(value => value === PermissionsAndroid.RESULTS.GRANTED)

            // Since we now handle NEVER_ASK_AGAIN in requestFeaturePermissions,
            // we just need to check if all are granted
            if (!allGranted) {
              // Check if any are NEVER_ASK_AGAIN to show proper dialog
              const anyNeverAskAgain = Object.values(results).some(
                value => value === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
              )

              if (anyNeverAskAgain) {
                // Show "previously denied" dialog for Bluetooth
                showAlert(
                  translate("pairing:permissionRequired"),
                  translate("pairing:bluetoothPermissionPreviouslyDenied"),
                  [
                    {
                      text: translate("pairing:openSettings"),
                      onPress: () => Linking.openSettings(),
                    },
                    {
                      text: translate("common:cancel"),
                      style: "cancel",
                    },
                  ],
                )
              } else {
                // Show standard permission required dialog
                showAlert(
                  translate("pairing:bluetoothPermissionRequiredTitle"),
                  translate("pairing:bluetoothPermissionRequiredMessage"),
                  [{text: translate("common:ok")}],
                )
              }
              return
            }
          }

          // Phone state permission already requested above for all Android devices
        } // End of Bluetooth permissions block
      } // End of Android-specific permissions block

      // Check connectivity early for iOS (permissions work differently)
      console.log("DEBUG: needsBluetoothPermissions:", needsBluetoothPermissions, "Platform.OS:", Platform.OS)
      if (needsBluetoothPermissions && Platform.OS === "ios") {
        console.log("DEBUG: Running iOS connectivity check early")
        const requirementsCheck = await coreCommunicator.checkConnectivityRequirements()
        if (!requirementsCheck.isReady) {
          // Show alert about missing requirements  
          showAlert(
            translate("pairing:connectionIssueTitle"),
            requirementsCheck.message || translate("pairing:connectionIssueMessage"),
            [{text: translate("common:ok")}],
          )
          return
        }
      }

      // Cross-platform permissions needed for both iOS and Android (only if connectivity check passed)
      if (needsBluetoothPermissions) {
        const hasBluetoothPermission = await requestFeaturePermissions(PermissionFeatures.BLUETOOTH)
        if (!hasBluetoothPermission) {
          showAlert(
            translate("pairing:bluetoothPermissionRequiredTitle"),
            translate("pairing:bluetoothPermissionRequiredMessageAlt"),
            [{text: translate("common:ok")}],
          )
          return // Stop the connection process
        }
      }

      // Request microphone permission (needed for both platforms)
      console.log("Requesting microphone permission...")

      // This now handles showing alerts for previously denied permissions internally
      const micGranted = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)

      console.log("Microphone permission result:", micGranted)

      if (!micGranted) {
        // The specific alert for previously denied permission is already handled in requestFeaturePermissions
        // We just need to stop the flow here
        return
      }

      // Request location permission (needed for both platforms)
      console.log("Requesting location permission...")

      // This now handles showing alerts for previously denied permissions internally
      const locGranted = await requestFeaturePermissions(PermissionFeatures.LOCATION)

      console.log("Location permission result:", locGranted)

      if (!locGranted) {
        // The specific alert for previously denied permission is already handled in requestFeaturePermissions
        // We just need to stop the flow here
        return
      }
    } catch (error) {
      console.error("Error requesting permissions:", error)
      showAlert(translate("pairing:errorTitle"), translate("pairing:permissionsError"), [
        {text: translate("common:ok")},
      ])
      return
    }

    // Check connectivity for Android after permissions are granted
    if (needsBluetoothPermissions && Platform.OS === "android") {
      const requirementsCheck = await coreCommunicator.checkConnectivityRequirements()
      if (!requirementsCheck.isReady) {
        // Show alert about missing requirements  
        showAlert(
          translate("pairing:connectionIssueTitle"),
          requirementsCheck.message || translate("pairing:connectionIssueMessage"),
          [{text: translate("common:ok")}],
        )
        return
      }
    }

    console.log("needsBluetoothPermissions", needsBluetoothPermissions)

    // slight delay for bluetooth perms
    router.push({pathname: "/pairing/bluetooth", params: {glassesModelName}})
  }

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.md}} safeAreaEdges={["bottom"]}>
      <Header titleTx="pairing:pairingGuide" leftIcon="caretLeft" onLeftPress={goBack} />
      <ScrollView style={{marginRight: -theme.spacing.md, paddingRight: theme.spacing.md}}>
        <View style={styles.contentContainer}>{getPairingGuide(glassesModelName)}</View>
      </ScrollView>
      <View style={{marginBottom: theme.spacing.md}}>
        <Button onPress={advanceToPairing} disabled={false}>
          <Text>{translate("common:continue")}</Text>
        </Button>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  darkBackground: {
    backgroundColor: "#1c1c1c",
  },
  darkText: {
    color: "#FFFFFF",
  },
  glassesImage: {
    height: 60,
    marginTop: 20,
    resizeMode: "contain",
    width: 100,
  },
  lightBackground: {
    backgroundColor: "#f0f0f0",
  },
  lightText: {
    color: "#333333",
  },
  scrollViewContainer: {
    flex: 1,
  },
  text: {
    fontSize: 16,
    marginBottom: 10,
  },
})
