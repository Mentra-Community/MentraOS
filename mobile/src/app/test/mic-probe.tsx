import {useLocalSearchParams} from "expo-router"
import {useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {Screen, Header, Text} from "@/components/ignite"
import {useAuth} from "@/contexts/AuthContext"
import {useNavigationStore} from "@/stores/navigation"
import {glassesMicProbe, parseMicProbeParams, type MicProbeSample} from "@mentra/engine"

/**
 * Dev screen: `com.mentra://test/mic-probe?seconds=20&a2dp=tone&level=0.2`
 *
 * Mirrors `[MIC_PROBE]` log lines. The engine service owns the soak lifetime so
 * boot/auth remounts do not pin the glasses mic during login or kill a run that
 * already started. Leaving the screen does not stop the probe; Back does.
 */
export default function MicProbe() {
  const {goBack} = useNavigationStore.getState()
  const {user} = useAuth()
  const params = useLocalSearchParams<{seconds?: string; a2dp?: string; level?: string}>()
  const initial = useRef(parseMicProbeParams(params))
  const [samples, setSamples] = useState<MicProbeSample[]>(() => {
    const last = glassesMicProbe.last()
    return last ? [last] : []
  })
  const [running, setRunning] = useState(glassesMicProbe.isRunning())

  useEffect(() => {
    const unsubscribe = glassesMicProbe.subscribe((sample) => {
      setSamples((prev) => [sample, ...prev].slice(0, 30))
      setRunning(glassesMicProbe.isRunning())
    })
    setRunning(glassesMicProbe.isRunning())
    // Cold-start deeplinks mount this route before auth. Starting here is what
    // flipped the glasses mic on during /auth/start. Wait for a signed-in user.
    if (user?.id && !glassesMicProbe.isRunning()) {
      void glassesMicProbe.start(initial.current)
    }
    return unsubscribe
  }, [user?.id])

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="Glasses mic probe"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => {
          void glassesMicProbe.stop()
          goBack()
        }}
        style={{height: 44}}
      />
      <View className="flex-1 px-4 py-2">
        <Text>
          {`${running ? "running" : "stopped"} · ${Math.round(initial.current.durationMs / 1000)}s · a2dp=${initial.current.a2dp}`}
        </Text>
        {samples.map((s) => (
          <Text key={`${s.t}-${s.frames}-${s.meanAbs}`}>
            {`t=${s.t}s meanAbs=${s.meanAbs} peak=${s.peak} frames=${s.frames} src=${s.source || "-"} a2dp=${s.a2dp}`}
          </Text>
        ))}
      </View>
    </Screen>
  )
}
