import {SETTINGS, useSetting} from "@mentra/engine"

import {MentraLivePairingFlowHost} from "@/components/pairing/MentraLivePairingFlowHost"

/**
 * Pair Audio for glasses that are already paired: the pairing-success setup steps and Home's
 * "Bluetooth Classic disconnected" alert open it. During pairing it is a page of the Engine's flow.
 */
export default function BtClassicPairingScreen() {
  const [deviceName] = useSetting<string>(SETTINGS.device_name.key)
  return <MentraLivePairingFlowHost deviceName={deviceName || ""} initialPage="pair_audio" />
}
