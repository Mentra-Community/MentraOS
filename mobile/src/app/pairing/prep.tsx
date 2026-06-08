import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {useRoute} from "@react-navigation/native"
import {Linking, PermissionsAndroid, Image, Platform, View} from "react-native"
import type {Permission} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {showAlert} from "@/utils/AlertUtils"
import {PermissionFeatures, checkConnectivityRequirementsUI, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {useState} from "react"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useAppStatusStore} from "@mentra/island"
import CoreModule from "@mentra/bluetooth-sdk"

type BluetoothPermission = Permission | "android.permission.BLUETOOTH" | "android.permission.BLUETOOTH_ADMIN"

export default function PairingPrepScreen() {
  const route = useRoute()
  const {deviceModel} = route.params as {deviceModel: string}
  const {goBack, push, clearHistoryAndGoHome} = useNavigationStore.getState()

  const advanceToPairing = async () => {
    if (deviceModel == null || deviceModel == "") {
      console.log("SOME WEIRD ERROR HERE")
      return
    }

    let needsBluetoothPermissions = true
    if (deviceModel.startsWith(DeviceTypes.SIMULATED) && Platform.OS === "ios") {
      needsBluetoothPermissions = false
    }

    try {
      if (Platform.OS === "android") {
        console.log("Requesting PHONE_STATE permission...")
        const phoneStateGranted = await requestFeaturePermissions(PermissionFeatures.PHONE_STATE)
        console.log("PHONE_STATE permission result:", phoneStateGranted)

        if (!phoneStateGranted) {
          return
        }

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
                    {text: translate("pairing:openSettings"), onPress: () => Linking.openSettings()},
                    {text: translate("common:cancel"), style: "cancel"},
                  ],
                )
              } else {
                showAlert(
                  translate("pairing:bluetoothPermissionRequiredTitle"),
                  translate("pairing:bluetoothPermissionRequiredMessage"),
                  [{text: translate("common:ok")}],
                )
              }
              return
            }
          }
        }
      }

      console.log("DEBUG: needsBluetoothPermissions:", needsBluetoothPermissions, "Platform.OS:", Platform.OS)
      if (needsBluetoothPermissions && Platform.OS === "ios") {
        console.log("DEBUG: Running iOS connectivity check early")
        const requirementsCheck = await checkConnectivityRequirementsUI()
        if (!requirementsCheck) {
          return
        }
      }

      if (needsBluetoothPermissions) {
        const hasBluetoothPermission = await requestFeaturePermissions(PermissionFeatures.BLUETOOTH)
        if (!hasBluetoothPermission) {
          showAlert(
            translate("pairing:bluetoothPermissionRequiredTitle"),
            translate("pairing:bluetoothPermissionRequiredMessageAlt"),
            [{text: translate("common:ok")}],
          )
          return
        }
      }

      console.log("Requesting microphone permission...")
      const micGranted = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
      console.log("Microphone permission result:", micGranted)

      if (!micGranted) {
        return
      }

      if (Platform.OS === "android") {
        console.log("Requesting location permission for Android BLE scanning...")
        const locGranted = await requestFeaturePermissions(PermissionFeatures.LOCATION)
        console.log("Location permission result:", locGranted)

        if (!locGranted) {
          return
        }

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

    await useAppStatusStore.getState().stopAll()

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
        title: translate("pairing:powerOn"),
        subtitle: translate("onboarding:livePowerOnTutorial"),
        info: translate("onboarding:livePowerOnInfo"),
        playCount: -1,
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
        skipFn={() => { advanceToPairing() }}
        endButtonText={translate("pairing:poweredOn")}
        endButtonFn={() => { advanceToPairing() }}
      />
    )
  }

  const MentraMach1PairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text className="text-lg text-secondary-foreground" text="1. Make sure your Mach1 is fully charged and turned on." />
        <Text className="text-lg text-secondary-foreground" text="2. Make sure your device is running the latest firmware by using the Vuzix Connect app." />
        <Text className="text-lg text-secondary-foreground" text="3. Put your Mentra Mach1 in pairing mode: hold the power button until you see the Bluetooth icon, then release." />
      </View>
    )
  }

  const VuzixZ100PairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text className="text-lg text-secondary-foreground" text="1. Make sure your Mach1 is fully charged and turned on." />
        <Text className="text-lg text-secondary-foreground" text="2. Make sure your device is running the latest firmware by using the Vuzix Connect app." />
        <Text className="text-lg text-secondary-foreground" text="3. Put your Mentra Mach1 in pairing mode: hold the power button until you see the Bluetooth icon, then release." />
      </View>
    )
  }

  const MentraDisplayGlassesPairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text text="Mentra Display" className="text-2xl font-bold mb-4 text-secondary-foreground" />
        <Text text="1. Make sure your Mentra Display is fully charged and turned on." className="text-lg text-secondary-foreground" />
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
          <Image source={require("../../../assets/guide/image_g1_pair.png")} resizeMode="contain" className="w-62 h-38" />
        </View>
        <View style={{justifyContent: "flex-start", flexDirection: "column"}}>
          <Text tx="pairing:instructions" className="text-2xl font-bold mb-4 text-secondary-foreground" />
          <Text className="text-lg text-secondary-foreground" text="1. Disconnect your G1 from within the Even Realities app, or uninstall the Even Realities app" />
          <Text className="text-lg text-secondary-foreground" text="2. Place your G1 in the charging case with the lid open." />
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
        <GlassesTroubleshootingModal isVisible={showTroubleshootingModal} onClose={() => setShowTroubleshootingModal(false)} deviceModel={deviceModel} />
      </>
    )
  }

  const G2PairingGuide = () => {
    const {theme} = useAppTheme()
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <View className="flex-col items-center justify-center bg-primary-foreground rounded-xl mb-6">
          <Image source={require("../../../assets/glasses/even_realities_g2/even_realities_g2.png")} resizeMode="contain" className="w-50 h-25" />
          <Icon name="chevron-down" size={36} color={theme.colors.text} />
          <Image source={require("../../../assets/guide/image_g1_pair.png")} resizeMode="contain" className="w-62 h-38" />
        </View>
        <View style={{justifyContent: "flex-start", flexDirection: "column"}}>
          <Text tx="pairing:instructions" className="text-2xl font-bold mb-4 text-secondary-foreground" />
          <Text className="text-lg text-secondary-foreground" text="1. Disconnect your G2 from within the Even Realities app, or uninstall the Even Realities app" />
          <Text className="text-lg text-secondary-foreground" text="2. Place your G2 in the charging case with the lid open." />
        </View>
      </View>
    )
  }

  const G2Buttons = () => {
    const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
    return (
      <>
        <View className="gap-4">
          <Button tx="pairing:g1Ready" onPress={advanceToPairing} />
          <Button tx="pairing:g1NotReady" preset="secondary" onPress={() => setShowTroubleshootingModal(true)} />
        </View>
        <GlassesTroubleshootingModal isVisible={showTroubleshootingModal} onClose={() => setShowTroubleshootingModal(false)} deviceModel={deviceModel} />
      </>
    )
  }

  // INMO Go2 pairing guide
  const InmoGo2PairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text text="INMO Go2" className="text-2xl font-bold mb-4 text-secondary-foreground" />
        <Text
          className="text-lg text-secondary-foreground"
          text="1. Make sure your INMO Go2 is fully charged and powered on."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="2. Put your INMO Go2 in pairing mode: press and hold the power button for 3 seconds until the LED flashes blue."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="3. Keep the glasses close to your phone during pairing."
        />
      </View>
    )
  }

  const renderGuide = () => {
    switch (deviceModel) {
      case DeviceTypes.SIMULATED:
        return <SimulatedPairingGuide />
      case DeviceTypes.G1:
        return <G1PairingGuide />
      case DeviceTypes.G2:
        return <G2PairingGuide />
      case DeviceTypes.LIVE:
        return <MentraLivePairingGuide />
      case DeviceTypes.MACH1:
        return <MentraMach1PairingGuide />
      case DeviceTypes.Z100:
        return <VuzixZ100PairingGuide />
      case DeviceTypes.NEX:
        return <MentraDisplayGlassesPairingGuide />
      case DeviceTypes.INMO_GO2:
        return <InmoGo2PairingGuide />
      default:
        return (
          <View className="flex-1 flex-col justify-start mt-6">
            <Text text={`Prepare your ${deviceModel} for pairing.`} className="text-lg text-secondary-foreground" />
          </View>
        )
    }
  }

  const renderButtons = () => {
    switch (deviceModel) {
      case DeviceTypes.G1:
        return <G1Buttons />
      case DeviceTypes.G2:
        return <G2Buttons />
      case DeviceTypes.LIVE:
        return null
      default:
        return <Button tx="common:continue" onPress={advanceToPairing} />
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header
        title={deviceModel}
        leftIcon="chevron-left"
        onLeftPress={goBack}
        RightActionComponent={<MentraLogoStandalone />}
      />
      {renderGuide()}
      {renderButtons()}
    </Screen>
  )
}
