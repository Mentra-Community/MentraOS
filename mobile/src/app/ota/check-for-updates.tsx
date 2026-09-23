import {useLocalSearchParams} from "expo-router"
import {DeviceOtaFlowHost} from "@/components/ota/DeviceOtaFlowHost"

export default function OtaCheckForUpdatesScreen() {
  const {entryPoint} = useLocalSearchParams<{entryPoint?: string}>()
  const entry =
    entryPoint === "settings" || entryPoint === "background" || entryPoint === "recovery" ? entryPoint : "pairing"
  return <DeviceOtaFlowHost initialPage="check" entryPoint={entry} />
}
