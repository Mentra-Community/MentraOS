import CoreModule from "core"
import {ActivityIndicator, View} from "react-native"

import {Button, Icon} from "@/components/ignite"
import {useCoreStatus} from "@/contexts/CoreStatusProvider"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import {useAppTheme} from "@/utils/useAppTheme"

import {DeviceTypes} from "@/../../cloud/packages/types/src"

export const ConnectDeviceButton = () => {
  const {status} = useCoreStatus()
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected = useGlassesStore(state => state.connected)
  const isSearching = status.core_info.is_searching

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
    if (status.core_info.is_searching) {
      await CoreModule.disconnect()
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
    return (
      <Button
        // textStyle={[{marginLeft: spacing.s12}]}
        // textAlignment="left"
        // LeftAccessory={() => <SolarLineIconsSet4 color={theme.colors.textAlt} />}
        // RightAccessory={() => <ChevronRight color={theme.colors.textAlt} />}
        onPress={() => push("/pairing/select-glasses-model")}
        tx="home:pairGlasses"
      />
    )
  }

  if (isSearching) {
    return (
      <View style={{flexDirection: "row", gap: theme.spacing.s2}}>
        <Button compactIcon flexContainer={false} preset="alternate" onPress={handleConnectOrDisconnect}>
          <Icon name="x" size={20} color={theme.colors.foreground} />
        </Button>
        <Button
          flex
          compact
          LeftAccessory={() => <ActivityIndicator size="small" color={theme.colors.textAlt} />}
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
