import {ControllerTypes, DeviceTypes} from "@/../../cloud/packages/types/src"
import CoreModule from "core"
import {ActivityIndicator, View} from "react-native"

import {Button, Icon} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import {useCoreStore} from "@/stores/core"

export const ConnectDeviceButton = () => {
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const isSearching = useCoreStore((state) => state.searching)

  if (glassesConnected) {
    return null
  }

  const connectGlasses = async () => {
    if (!defaultWearable) {
      push("/pairing/select-glasses-model")
      return
    }

    try {
      // Check that Bluetooth and Location are enabled/granted
      const requirementsCheck = await checkConnectivityRequirementsUI()

      if (!requirementsCheck) {
        return
      }

      await CoreModule.connectDefault()
    } catch (err) {
      console.error("connect to glasses error:", err)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    }
  }

  // New handler: if already connecting, pressing the button calls disconnect.
  const handleConnectOrDisconnect = async () => {
    if (isSearching) {
      await CoreModule.disconnectController()
    } else {
      await connectGlasses()
    }
  }

  // if we have simulated glasses, show nothing:
  if (defaultWearable.includes(DeviceTypes.SIMULATED)) {
    return null
  }

  // Debug the conditional logic
  const defaultWearableNull = defaultWearable == null
  const defaultWearableStringNull = defaultWearable == "null"
  const defaultWearableEmpty = defaultWearable === ""

  if (defaultWearableNull || defaultWearableStringNull || defaultWearableEmpty) {
    return <Button onPress={() => push("/pairing/select-glasses-model")} tx="home:pairGlasses" />
  }

  if (isSearching) {
    return (
      <View style={{flexDirection: "row", gap: theme.spacing.s2}}>
        {/* <Button compactIcon preset="alternate" onPress={handleConnectOrDisconnect}>
          <Icon name="x" size={20} color={theme.colors.foreground} />
        </Button> */}
        <Button
          onPress={handleConnectOrDisconnect}
          flex
          compact
          LeftAccessory={() => <ActivityIndicator size="small" color={theme.colors.foreground} />}
          tx="home:connectingGlasses"
        />
      </View>
    )
  }

  if (!glassesConnected) {
    return (
      <Button
        compact
        preset="primary"
        onPress={handleConnectOrDisconnect}
        tx="home:connectGlasses"
        disabled={isSearching}
      />
    )
  }

  return null
}

export const ConnectControllerButton = () => {
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [defaultController] = useSetting(SETTINGS.default_controller.key)
  const controllerConnected = useGlassesStore((state) => state.controllerConnected)
  const isSearching = useCoreStore((state) => state.searchingController)

  if (controllerConnected) {
    return null
  }

  const connectController = async () => {
    if (!defaultController) {
      push("/pairing/select-glasses-model")
      return
    }

    try {
      // Check that Bluetooth and Location are enabled/granted
      const requirementsCheck = await checkConnectivityRequirementsUI()

      if (!requirementsCheck) {
        return
      }

      await CoreModule.connectDefaultController()
    } catch (err) {
      console.error("connect to glasses error:", err)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    }
  }

  // New handler: if already connecting, pressing the button calls disconnect.
  const handleConnectOrDisconnect = async () => {
    if (isSearching) {
      await CoreModule.disconnect()
    } else {
      await connectController()
    }
  }

  // Debug the conditional logic
  const defaultControllerNull = defaultController == null
  const defaultControllerStringNull = defaultController == "null"
  const defaultControllerEmpty = defaultController === ""

  if (defaultControllerNull || defaultControllerStringNull || defaultControllerEmpty) {
    return <Button onPress={() => push("/pairing/select-glasses-model")} tx="home:pairController" />
  }

  if (isSearching) {
    return (
      <View style={{flexDirection: "row", gap: theme.spacing.s2}}>
        {/* <Button compactIcon preset="alternate" onPress={handleConnectOrDisconnect}>
          <Icon name="x" size={20} color={theme.colors.foreground} />
        </Button> */}
        <Button
          onPress={handleConnectOrDisconnect}
          flex
          compact
          LeftAccessory={() => <ActivityIndicator size="small" color={theme.colors.primary_foreground} />}
          tx="home:connectingController"
        />
      </View>
    )
  }

  if (!controllerConnected) {
    return (
      <Button
        compact
        preset="primary"
        onPress={handleConnectOrDisconnect}
        tx="home:connectController"
        disabled={isSearching}
      />
    )
  }

  return null
}
