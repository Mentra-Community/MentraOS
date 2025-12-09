import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {useRoute} from "@react-navigation/native"
import CoreModule from "core"
import {Linking, PermissionsAndroid, Platform, ScrollView} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Header} from "@/components/ignite"
import {Screen} from "@/components/ignite/Screen"
import {PairingGuide, PairingOptions} from "@/components/pairing/GlassesPairingGuides"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {$styles} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import {PermissionFeatures, checkConnectivityRequirementsUI, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export default function PairingPrepScreen() {
  const route = useRoute()
  const {themed, theme} = useAppTheme()
  const {glassesModelName} = route.params as {glassesModelName: string}
  const {goBack, replace, clearHistoryAndGoHome} = useNavigationHistory()

  const advanceToPairing = async () => {
    if (glassesModelName == null || glassesModelName == "") {
      console.log("SOME WEIRD ERROR HERE")
      return
    }

    // Always request Bluetooth permissions - required for Android 14+ foreground service
    let needsBluetoothPermissions = true
    // we don't need bluetooth permissions for simulated glasses
    if (glassesModelName.startsWith(DeviceTypes.SIMULATED) && Platform.OS === "ios") {
      needsBluetoothPermissions = false
    }

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
          if (typeof Platform.Version === "number" && Platform.Version < 31) {
            // For Android 9, 10, and 11 (API 28-30), use legacy Bluetooth permissions
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH || "android.permission.BLUETOOTH")
            bluetoothPermissions.push(
              PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADMIN || "android.permission.BLUETOOTH_ADMIN",
            )
          }
          if (typeof Platform.Version === "number" && Platform.Version >= 31) {
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN)
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT)
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE)

            // Add NEARBY_DEVICES permission for Android 12+ (API 31+)
            // Only add if the permission is defined and not null
            if (PermissionsAndroid.PERMISSIONS.NEARBY_DEVICES != null) {
              bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_DEVICES)
            }
          }

          // Request Bluetooth permissions directly
          if (bluetoothPermissions.length > 0) {
            console.log("RIGHT BEFORE ASKING FOR PERMS")
            console.log("Bluetooth permissions array:", bluetoothPermissions)
            console.log(
              "Bluetooth permission values:",
              bluetoothPermissions.map(p => `${p} (${typeof p})`),
            )

            // Filter out any null/undefined permissions
            const validBluetoothPermissions = bluetoothPermissions.filter(permission => permission != null)
            console.log("Valid Bluetooth permissions after filtering:", validBluetoothPermissions)

            if (validBluetoothPermissions.length === 0) {
              console.warn("No valid Bluetooth permissions to request")
              return
            }

            const results = await PermissionsAndroid.requestMultiple(validBluetoothPermissions)
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
        const requirementsCheck = await checkConnectivityRequirementsUI()
        if (!requirementsCheck) {
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

      // Request location permission (needed for Android BLE scanning)
      if (Platform.OS === "android") {
        console.log("Requesting location permission for Android BLE scanning...")

        // This now handles showing alerts for previously denied permissions internally
        const locGranted = await requestFeaturePermissions(PermissionFeatures.LOCATION)

        console.log("Location permission result:", locGranted)

        if (!locGranted) {
          // The specific alert for previously denied permission is already handled in requestFeaturePermissions
          // We just need to stop the flow here
          return
        }
      } else {
        console.log("Skipping location permission on iOS - not needed after BLE fix")
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
      const requirementsCheck = await checkConnectivityRequirementsUI()
      if (!requirementsCheck) {
        return
      }
    }

    console.log("needsBluetoothPermissions", needsBluetoothPermissions)

    // skip pairing for simulated glasses:
    if (glassesModelName.startsWith(DeviceTypes.SIMULATED)) {
      await CoreModule.connectSimulated()
      clearHistoryAndGoHome()
      return
    }

    replace("/pairing/scan", {glassesModelName})
  }

  return (
    <Screen preset="fixed" style={themed($styles.screen)} safeAreaEdges={["bottom"]}>
      <Header
        title={glassesModelName}
        leftIcon="chevron-left"
        onLeftPress={goBack}
        RightActionComponent={<MentraLogoStandalone />}
      />
      <ScrollView style={{marginRight: -theme.spacing.s6, paddingRight: theme.spacing.s6}}>
        <PairingGuide model={glassesModelName} />
      </ScrollView>
      <PairingOptions model={glassesModelName} continueFn={advanceToPairing} />
    </Screen>
  )
}
