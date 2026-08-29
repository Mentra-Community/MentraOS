import {DeviceTypes} from "@mentra/engine"
import {decideConnectButtonAction, engine} from "@mentra/engine"
import {ActivityIndicator, View} from "react-native"

import {Button} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@mentra/engine"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"

export const ConnectDeviceButton = () => {
  const {theme} = useAppTheme()
  const {push} = useNavigationStore.getState()
  // Pairing-identity read-model: none | pending (chosen, never paired) | paired.
  const identity = useEngineSnapshot(engine.pairing.identity, (onChange) => engine.pairing.onIdentity(onChange))
  const pairedModel = identity.kind === "paired" ? identity.model : ""
  const glassesStatus = useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange))
  const glassesConnected = glassesStatus.state === "connected"
  const isSearching = useEngineSnapshot(engine.pairing.scanning, (onChange) => engine.pairing.onScanning(onChange))
  // Same busy source as home's DeviceStatus: an active scan OR the native link
  // layer mid connect/bond — either way a tap must cancel, not start a second
  // connect.
  const pairingReadiness = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  )
  const busy = isSearching || pairingReadiness.nativeLinkBusy

  if (glassesConnected) {
    return null
  }

  const connectGlasses = async () => {
    if (!pairedModel) {
      push("/pairing/select-glasses-model")
      return
    }

    try {
      // Check that Bluetooth and Location are enabled/granted
      const requirementsCheck = await checkConnectivityRequirementsUI()

      if (!requirementsCheck) {
        return
      }

      // A `paired` identity snapshot does not imply a native device to connect
      // to (the settings echo can outlive the native pairing). Without a
      // device, connectDefault() throws — route back into pairing for the
      // already-selected model instead of surfacing an error alert. Fail open
      // on a read error: connectDefault()'s catch is the pre-guard behavior.
      if (!(await engine.glasses.hasDefaultDevice().catch(() => true))) {
        if (pairedModel === DeviceTypes.AR99) {
          push("/pairing/select-glasses-model")
        } else {
          push("/pairing/scan", {deviceModel: pairedModel})
        }
        return
      }

      await engine.glasses.connectDefault()
    } catch (err) {
      console.error("connect to glasses error:", err)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    }
  }

  // New handler: if already connecting, pressing the button calls disconnect.
  const handleConnectOrDisconnect = async () => {
    const action = decideConnectButtonAction({hasDefaultWearable: !!pairedModel, busy})
    if (action === "cancel") {
      await engine.glasses.disconnect()
    } else {
      await connectGlasses()
    }
  }

  // if we have simulated glasses, show nothing:
  if (pairedModel.includes(DeviceTypes.SIMULATED)) {
    return null
  }

  if (identity.kind !== "paired") {
    // A pending selection (chosen model, pairing never completed) resumes the
    // scan for that model instead of restarting from model selection.
    if (identity.kind === "pending") {
      if (identity.model === DeviceTypes.AR99) {
        return <Button onPress={() => push("/pairing/select-glasses-model")} tx="home:finishPairingGlasses" />
      }
      return <Button onPress={() => push("/pairing/scan", {deviceModel: identity.model})} tx="home:finishPairingGlasses" />
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
  const controllerStatus = useEngineSnapshot(engine.glasses.controller.status, (onChange) =>
    engine.glasses.controller.onStatus(onChange),
  )
  const controllerConnected = controllerStatus.connected
  const isSearching = useEngineSnapshot(engine.pairing.scanningController, (onChange) =>
    engine.pairing.onScanningController(onChange),
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

      await engine.glasses.controller.connectDefault()
    } catch (err) {
      console.error("connect to glasses error:", err)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    }
  }

  // New handler: if already connecting, pressing the button calls disconnect.
  const handleConnectOrDisconnect = async () => {
    const action = decideConnectButtonAction({hasDefaultWearable: !!defaultController, busy: isSearching})
    if (action === "cancel") {
      await engine.glasses.controller.disconnect()
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


