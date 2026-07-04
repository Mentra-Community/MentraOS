import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {decideConnectButtonAction, toolkit} from "@mentra/island"
import {ActivityIndicator, View} from "react-native"

import {Button} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useToolkitSnapshot} from "@/hooks/useToolkitSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@/stores/settings"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"

export const ConnectDeviceButton = () => {
  const {theme} = useAppTheme()
  const {push} = useNavigationStore.getState()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [pendingWearable] = useSetting(SETTINGS.pending_wearable.key)
  const glassesStatus = useToolkitSnapshot(toolkit.glasses.status, (onChange) => toolkit.glasses.onStatus(onChange))
  const glassesConnected = glassesStatus.state === "connected"
  const isSearching = useToolkitSnapshot(toolkit.pairing.scanning, (onChange) => toolkit.pairing.onScanning(onChange))
  // Same busy source as home's DeviceStatus: an active scan OR the native link
  // layer mid connect/bond — either way a tap must cancel, not start a second
  // connect.
  const pairingReadiness = useToolkitSnapshot(toolkit.pairing.readiness, (onChange) =>
    toolkit.pairing.onReadiness(onChange),
  )
  const busy = isSearching || pairingReadiness.nativeLinkBusy

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

      // A chosen model (default_wearable) does not imply a paired device (an
      // orphaned identity the boot demotion hasn't repaired yet). Without a
      // device, connectDefault() throws — route back into pairing for the
      // already-selected model instead of surfacing an error alert. Fail open
      // on a read error: connectDefault()'s catch is the pre-guard behavior.
      if (!(await toolkit.glasses.hasDefaultDevice().catch(() => true))) {
        push("/pairing/scan", {deviceModel: defaultWearable})
        return
      }

      await toolkit.glasses.connectDefault()
    } catch (err) {
      console.error("connect to glasses error:", err)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    }
  }

  // New handler: if already connecting, pressing the button calls disconnect.
  const handleConnectOrDisconnect = async () => {
    const action = decideConnectButtonAction({hasDefaultWearable: !!defaultWearable, busy})
    if (action === "cancel") {
      await toolkit.glasses.disconnect()
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
    // A pending selection (chosen model, pairing never completed) resumes the
    // scan for that model instead of restarting from model selection.
    if (pendingWearable) {
      return (
        <Button onPress={() => push("/pairing/scan", {deviceModel: pendingWearable})} tx="home:finishPairingGlasses" />
      )
    }
    return <Button onPress={() => push("/pairing/select-glasses-model")} tx="home:pairGlasses" />
  }

  if (busy) {
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
      <Button compact preset="primary" onPress={handleConnectOrDisconnect} tx="home:connectGlasses" disabled={busy} />
    )
  }

  return null
}

export const ConnectControllerButton = () => {
  const {theme} = useAppTheme()
  const {push} = useNavigationStore.getState()
  const [defaultController] = useSetting(SETTINGS.default_controller.key)
  const controllerStatus = useToolkitSnapshot(toolkit.glasses.controller.status, (onChange) =>
    toolkit.glasses.controller.onStatus(onChange),
  )
  const controllerConnected = controllerStatus.connected
  const isSearching = useToolkitSnapshot(toolkit.pairing.scanningController, (onChange) =>
    toolkit.pairing.onScanningController(onChange),
  )

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

      await toolkit.glasses.controller.connectDefault()
    } catch (err) {
      console.error("connect to glasses error:", err)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    }
  }

  // New handler: if already connecting, pressing the button calls disconnect.
  const handleConnectOrDisconnect = async () => {
    const action = decideConnectButtonAction({hasDefaultWearable: !!defaultController, busy: isSearching})
    if (action === "cancel") {
      await toolkit.glasses.controller.disconnect()
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
