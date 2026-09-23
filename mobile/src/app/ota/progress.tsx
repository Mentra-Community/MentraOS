import {DeviceOtaFlowHost} from "@/components/ota/DeviceOtaFlowHost"

export default function OtaProgressScreen() {
  return <DeviceOtaFlowHost initialPage="progress" entryPoint="recovery" />
}
