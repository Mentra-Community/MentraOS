import {engine} from "@mentra/engine"
import {useEffect, useState, useSyncExternalStore} from "react"
import {View} from "react-native"

import {Text} from "@/components/ignite"
import {useAuth} from "@/contexts/AuthContext"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"

type NativeRecovery = Parameters<Parameters<typeof engine.firmwareUpdates.observeNativeRecovery>[0]>[0]

/** A passive status surface that survives the signed-in route tree. It cannot resume optional work. */
export function FirmwareRecoveryStatus() {
  const {user} = useAuth()
  const {top} = useSaferAreaInsets()
  const sessions = useSyncExternalStore(
    engine.firmwareUpdates.subscribeRetained,
    engine.firmwareUpdates.retainedSnapshots,
    engine.firmwareUpdates.retainedSnapshots,
  )
  const [native, setNative] = useState<NativeRecovery>(null)
  useEffect(() => engine.firmwareUpdates.observeNativeRecovery(setNative), [])
  const updating =
    sessions.find((session) => !session.safeToRelease) ?? (native?.safeToRelease === false ? native : null)
  if (user || !updating) return null
  const interrupted = updating.phase === "interrupted" || updating.phase === "failed"
  return (
    <View className="bg-primary-foreground px-4 pb-3" style={{paddingTop: top + 8}} accessibilityRole="alert">
      <Text weight="bold" tx={interrupted ? "ota:recoveryNeedsAttention" : "ota:recoveryUpdating"} />
      <Text tx="ota:recoverySignedOut" />
    </View>
  )
}
