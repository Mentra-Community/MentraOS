import {useLocalSearchParams} from "expo-router"

import {MentraLivePairingFlowHost} from "@/components/pairing/MentraLivePairingFlowHost"
import type {ForgetIosPairingThen} from "@/utils/pairing/iosStaleBond"

/**
 * "Forget the old pairing" after Unpair or sign-out on iOS and the Mac: an app there can't remove a
 * Bluetooth bond, so the person does it in Settings. A failed pairing shows the same page inside the
 * Engine's flow.
 */
export default function ForgetIosPairingScreen() {
  const {deviceName, then} = useLocalSearchParams<{deviceName?: string; then?: ForgetIosPairingThen}>()
  return <MentraLivePairingFlowHost deviceName={deviceName ?? ""} initialPage="forget_ios_pairing" then={then} />
}
