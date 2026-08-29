import {engine} from "@mentra/engine"
import {Linking, PermissionsAndroid, Platform} from "react-native"
import type {Permission} from "react-native"

import {DeviceTypes} from "@mentra/engine"
import {translate} from "@/i18n"
import {showAlert} from "@/utils/AlertUtils"
import {PermissionFeatures, checkConnectivityRequirementsUI, requestFeaturePermissions} from "@/utils/PermissionsUtils"

type BluetoothPermission = Permission | "android.permission.BLUETOOTH" | "android.permission.BLUETOOTH_ADMIN"

/**
 * Requests the permissions and connectivity needed before opening a pairing scan.
 * Returns false when the user or device blocks setup, leaving navigation to the caller.
 */
export async function preparePairingScan(deviceModel: string): Promise<boolean> {
  if (!deviceModel) {
    console.error("Cannot prepare pairing scan without a device model")
    return false
  }

  const needsBluetoothPermissions = !deviceModel.startsWith(DeviceTypes.SIMULATED) || Platform.OS !== "ios"

  try {
    if (Platform.OS === "android") {
      const phoneStateGranted = await requestFeaturePermissions(PermissionFeatures.PHONE_STATE)
      if (!phoneStateGranted) return false

      if (needsBluetoothPermissions) {
        const bluetoothPermissions: BluetoothPermission[] = []

        if (typeof Platform.Version === "number" && Platform.Version < 31) {
          bluetoothPermissions.push("android.permission.BLUETOOTH")
          bluetoothPermissions.push("android.permission.BLUETOOTH_ADMIN")
        }
        if (typeof Platform.Version === "number" && Platform.Version >= 31) {
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN)
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT)
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE)
        }

        if (bluetoothPermissions.length > 0) {
          const results = await PermissionsAndroid.requestMultiple(bluetoothPermissions as Permission[])
          const allGranted = Object.values(results).every((value) => value === PermissionsAndroid.RESULTS.GRANTED)

          if (!allGranted) {
            const anyNeverAskAgain = Object.values(results).some(
              (value) => value === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
            )

            if (anyNeverAskAgain) {
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
              showAlert(
                translate("pairing:bluetoothPermissionRequiredTitle"),
                translate("pairing:bluetoothPermissionRequiredMessage"),
                [{text: translate("common:ok")}],
              )
            }
            return false
          }
        }
      }
    }

    if (needsBluetoothPermissions && Platform.OS === "ios") {
      const requirementsMet = await checkConnectivityRequirementsUI()
      if (!requirementsMet) return false
    }

    if (needsBluetoothPermissions) {
      const bluetoothGranted = await requestFeaturePermissions(PermissionFeatures.BLUETOOTH)
      if (!bluetoothGranted) {
        showAlert(
          translate("pairing:bluetoothPermissionRequiredTitle"),
          translate("pairing:bluetoothPermissionRequiredMessageAlt"),
          [{text: translate("common:ok")}],
        )
        return false
      }
    }

    const microphoneGranted = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
    if (!microphoneGranted) return false

    if (Platform.OS === "android") {
      const locationGranted = await requestFeaturePermissions(PermissionFeatures.LOCATION)
      if (!locationGranted) return false

      if (needsBluetoothPermissions) {
        const requirementsMet = await checkConnectivityRequirementsUI()
        if (!requirementsMet) return false
      }
    }
  } catch (error) {
    console.error("Error requesting pairing permissions:", error)
    showAlert(translate("pairing:errorTitle"), translate("pairing:permissionsError"), [{text: translate("common:ok")}])
    return false
  }

  // Pairing owns the microphone. Backend app shutdown can be slow, so do not block navigation.
  void engine.miniapps.stopAll()
  return true
}
