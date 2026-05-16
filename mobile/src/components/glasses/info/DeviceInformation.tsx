import {ViewStyle} from "react-native"

import InfoSection from "@/components/ui/InfoSection"
import {useGlassesStore} from "@/stores/glasses"

export function DeviceInformation({style}: {style?: ViewStyle}) {
  const bluetoothName = useGlassesStore((state) => state.bluetoothName)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  const localIpAddress = useGlassesStore((state) => (state.wifi.state === "connected" ? state.wifi.localIp : undefined))

  return (
    <InfoSection
      style={style}
      title="Device Information"
      items={[
        {label: "Bluetooth Name", value: bluetoothName?.split("_")[3]},
        {label: "Build Number", value: buildNumber},
        {label: "Local IP Address", value: localIpAddress},
      ]}
    />
  )
}
