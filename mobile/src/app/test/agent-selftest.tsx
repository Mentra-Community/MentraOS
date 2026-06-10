/**
 * @fileoverview Agent harness self-test route (dev-only).
 *
 * A known-crashing screen the app-health sweep uses to PROVE its error channel
 * actually catches render failures — a green sweep is only trustworthy if a
 * deliberately broken screen turns it red. Renders fine normally; throws a
 * render error only when navigated with `?crash=1`, so it is inert unless the
 * harness asks for it. Outside __DEV__ it renders an empty view.
 */
import {View} from "react-native"
import {useLocalSearchParams} from "expo-router"

import {Screen, Text} from "@/components/ignite"

export default function AgentSelfTest() {
  const {crash} = useLocalSearchParams<{crash?: string}>()

  if (__DEV__ && crash === "1") {
    // Intentional: a render-time throw the global handler / error boundary
    // reports, exactly like a real broken screen would.
    throw new Error("agent-selftest: deliberate render crash (error-channel probe)")
  }

  return (
    <Screen preset="fixed">
      <View className="flex-1 items-center justify-center">
        <Text text="agent self-test route (healthy)" />
      </View>
    </Screen>
  )
}
