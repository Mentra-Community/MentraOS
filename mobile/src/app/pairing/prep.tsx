import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {useRoute} from "@react-navigation/native"
import CoreModule from "core"
import {Linking, PermissionsAndroid, Image, Platform, View} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {showAlert} from "@/utils/AlertUtils"
import {PermissionFeatures, checkConnectivityRequirementsUI, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {useState} from "react"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {Spacer} from "@/components/ui/Spacer"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useAppletStatusStore} from "@/stores/applets"

export default function PairingPrepScreen() {
  const route = useRoute()
  const {theme} = useAppTheme()
  const {deviceModel} = route.params as {deviceModel: string}
  const {goBack, push, clearHistoryAndGoHome} = useNavigationHistory()

  const advanceToPairing = async () => {
    if (deviceModel == null || deviceModel == "") {
      console.log("SOME WEIRD ERROR HERE")
      return
    }

    // Always request Bluetooth permissions - required for Android 14+ foreground service
    let needsBluetoothPermissions = true
    // we don't need bluetooth permissions for simulated glasses
    if (deviceModel.startsWith(DeviceTypes.SIMULATED) && Platform.OS === "ios") {
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
              bluetoothPermissions.map((p) => `${p} (${typeof p})`),
            )

            // Filter out any null/undefined permissions
            const validBluetoothPermissions = bluetoothPermissions.filter((permission) => permission != null)
            console.log("Valid Bluetooth permissions after filtering:", validBluetoothPermissions)

            if (validBluetoothPermissions.length === 0) {
              console.warn("No valid Bluetooth permissions to request")
              return
            }

            const results = await PermissionsAndroid.requestMultiple(validBluetoothPermissions)
            const allGranted = Object.values(results).every((value) => value === PermissionsAndroid.RESULTS.GRANTED)

            // Since we now handle NEVER_ASK_AGAIN in requestFeaturePermissions,
            // we just need to check if all are granted
            if (!allGranted) {
              // Check if any are NEVER_ASK_AGAIN to show proper dialog
              const anyNeverAskAgain = Object.values(results).some(
                (value) => value === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
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

        // Check connectivity for Android AFTER all permissions are granted
        // This must be done after location permission is granted to avoid premature "Connection issue" popup
        if (needsBluetoothPermissions) {
          const requirementsCheck = await checkConnectivityRequirementsUI()
          if (!requirementsCheck) {
            return
          }
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

    console.log("needsBluetoothPermissions", needsBluetoothPermissions)

    // Stop any running apps from previous sessions to prevent mic race conditions
    // This is symmetric with the logic in DeviceSettings that stops apps when unpairing
    await useAppletStatusStore.getState().stopAllApplets()

    // skip pairing for simulated glasses:
    if (deviceModel.startsWith(DeviceTypes.SIMULATED)) {
      await CoreModule.connectSimulated()
      clearHistoryAndGoHome()
      return
    }

    push("/pairing/scan", {deviceModel})
  }

  const SimulatedPairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start">
        <Text text="Preview MentraOS" className="text-2xl font-bold mb-4 text-secondary-foreground" />
        <GlassesDisplayMirror demoText="Simulated glasses display" />
        <Text
          text="Experience the full power of MentraOS without physical glasses. Simulated Glasses provides a virtual display that mirrors exactly what you would see on real smart glasses."
          className="text-sm text-secondary-foreground mt-6"
        />
      </View>
    )
  }

  const MentraLivePairingGuide = () => {
    const CDN_BASE = "https://mentra-videos-cdn.mentraglass.com/onboarding/mentra-live/light"
    let steps: OnboardingStep[] = [
      {
        name: "power_on_tutorial",
        type: "video",
        source: `${CDN_BASE}/ONB1_power_button_loop.mp4`,
        poster: require("@assets/onboarding/live/thumbnails/ONB0_power.png"),
        transition: false,
        title: translate("pairing:powerOn"), // for spacing so it's consistent with the other steps
        subtitle: translate("onboarding:livePowerOnTutorial"),
        info: translate("onboarding:livePowerOnInfo"),
        playCount: -1, // repeat forever
        showButtonImmediately: true,
      },
    ]

    return (
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showCloseButton={false}
        showSkipButton={false}
        showHeader={false}
        skipFn={() => {
          advanceToPairing()
        }}
        endButtonText={translate("pairing:poweredOn")}
        endButtonFn={() => {
          advanceToPairing()
        }}
      />
    )
  }

  const MentraMach1PairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text
          className="text-lg text-secondary-foreground"
          text="1. Make sure your Mach1 is fully charged and turned on."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="2. Make sure your device is running the latest firmware by using the Vuzix Connect app."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="3. Put your Mentra Mach1 in pairing mode: hold the power button until you see the Bluetooth icon, then release."
        />
      </View>
    )
  }

  const VuzixZ100PairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text
          className="text-lg text-secondary-foreground"
          text="1. Make sure your Mach1 is fully charged and turned on."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="2. Make sure your device is running the latest firmware by using the Vuzix Connect app."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="3. Put your Mentra Mach1 in pairing mode: hold the power button until you see the Bluetooth icon, then release."
        />
      </View>
    )
  }

  const MentraDisplayGlassesPairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text text="Mentra Display" className="text-2xl font-bold mb-4 text-secondary-foreground" />
        <Text
          text="1. Make sure your Mentra Display is fully charged and turned on."
          className="text-lg text-secondary-foreground"
        />
      </View>
    )
  }

  const G1PairingGuide = () => {
    const {theme} = useAppTheme()

    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <View className="flex-col items-center justify-center bg-primary-foreground rounded-xl mb-6">
          <Image source={require("../../../assets/glasses/g1.png")} resizeMode="contain" className="w-50 h-25" />
          <Icon name="chevron-down" size={36} color={theme.colors.text} />
          <Image
            source={require("../../../assets/guide/image_g1_pair.png")}
            resizeMode="contain"
            className="w-62 h-38"
          />
        </View>

        <View style={{justifyContent: "flex-start", flexDirection: "column"}}>
          <Text tx="pairing:instructions" className="text-2xl font-bold mb-4 text-secondary-foreground" />
          <Text
            className="text-lg text-secondary-foreground"
            text="1. Disconnect your G1 from within the Even Realities app, or uninstall the Even Realities app"
          />
          <Text
            className="text-lg text-secondary-foreground"
            text="2. Place your G1 in the charging case with the lid open."
          />
        </View>
      </View>
    )
  }

  const G1Buttons = () => {
    const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
    return (
      <>
        <View className="gap-4">
          <Button tx="pairing:g1Ready" onPress={advanceToPairing} />
          <Button tx="pairing:g1NotReady" preset="secondary" onPress={() => setShowTroubleshootingModal(true)} />
        </View>
        <GlassesTroubleshootingModal
          isVisible={showTroubleshootingModal}
          onClose={() => setShowTroubleshootingModal(false)}
          deviceModel={deviceModel}
        />
      </>
    )
  }

  const renderGuide = () => {
    switch (deviceModel) {
      case DeviceTypes.SIMULATED:
        return <SimulatedPairingGuide />
      case DeviceTypes.G1:
        return <G1PairingGuide />
      case DeviceTypes.LIVE:
        return <MentraLivePairingGuide />
      case DeviceTypes.MACH1:
        return <MentraMach1PairingGuide />
      case DeviceTypes.Z100:
        return <VuzixZ100PairingGuide />
      case DeviceTypes.NEX:
        return <MentraDisplayGlassesPairingGuide />
    }

    throw new Error(`Unknown model name: ${deviceModel}`)
  }

  const renderButtons = () => {
    switch (deviceModel) {
      case DeviceTypes.G1:
        return <G1Buttons />
      case DeviceTypes.LIVE:
        return null
      default:
        return <Button tx="common:continue" onPress={advanceToPairing} />
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header
        title={deviceModel}
        leftIcon="chevron-left"
        onLeftPress={goBack}
        RightActionComponent={<MentraLogoStandalone />}
      />
      <Spacer height={theme.spacing.s6} />
      {/* <ScrollView style={{marginRight: -theme.spacing.s6, paddingRight: theme.spacing.s6}}> */}
      {/* </ScrollView> */}

      {/* <PairingGuide model={deviceModel} /> */}
      {/* <PairingOptions model={deviceModel} continueFn={advanceToPairing} /> */}
      {renderGuide()}
      {renderButtons()}
    </Screen>
  )
}
