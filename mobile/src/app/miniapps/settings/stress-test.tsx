// Test/benchmark infrastructure. Reachable only via Super Settings →
// Stress Test, which is itself gated behind Super Mode.
//
// Pre-Phase-3 this screen drove the WebView jetsam experiment that
// settled the architecture decision (persistent off-screen WebViews
// don't survive on iPhone SE2 — see
// agents/spike-results/jsc-spike-iphone15-release-50ctx.log). Now that
// the architecture is two-layer JSContext + on-demand foreground
// WebView, the WebView-jetsam path is gone. What remains is the JSC
// memory-spike harness for ongoing measurements on new hardware tiers.

import {useEffect} from "react"
import {ScrollView, View, Text} from "react-native"

import CoreModule from "@mentra/bluetooth-sdk"

import {Header, Screen} from "@/components/ignite"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"
import {useNavigationStore} from "@/stores/navigation"
import {useStressTestStore} from "@/stores/stressTest"

const POLL_MS = 1000

export default function StressTest() {
  const {goBack} = useNavigationStore.getState()
  const {active, residentMB, memWarnCount, start, stop, setResidentMB} = useStressTestStore()

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null
    const tick = () => {
      try {
        const mb = CoreModule.getMemoryMB()
        setResidentMB(mb)
        if (active) {
          // eslint-disable-next-line no-console
          console.log(
            `STRESS: sample ${JSON.stringify({
              at: Date.now(),
              residentMB: mb,
              memwarn: memWarnCount,
            })}`,
          )
        }
      } catch {
        // CoreModule may not be loaded on Android — ignore.
      }
    }
    tick()
    id = setInterval(tick, POLL_MS)
    return () => {
      if (id) clearInterval(id)
    }
  }, [active, memWarnCount, setResidentMB])

  return (
    <Screen preset="fixed">
      <Header title="Stress Test" leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-4 mt-6">
          <Group title="State">
            <View className="px-4 py-3">
              <Text className="text-text">Resident: {residentMB.toFixed(1)} MB</Text>
              <Text className="text-text">Memory warnings: {memWarnCount}</Text>
              <Text className="text-text">Logging active: {active ? "yes" : "no"}</Text>
            </View>
          </Group>

          <Group title="Logging">
            <RouteButton
              label={active ? "Stop logging" : "Start logging"}
              subtitle={active ? "Sampling and STRESS: lines flowing" : "Begin a test run (timestamps)"}
              onPress={() => (active ? stop() : start())}
            />
          </Group>

          <Group title="JSContext memory benchmark (no WebView)">
            <RouteButton
              label="Spawn 1 JSContext"
              subtitle="Measures per-context memory cost"
              onPress={() => {
                const baseline = CoreModule.getMemoryMB()
                const result = (CoreModule as unknown as {jscSpawnAndMeasure: (n: number, b: number) => unknown}).jscSpawnAndMeasure(1, baseline)
                // eslint-disable-next-line no-console
                console.log("STRESS: jsc-spike", JSON.stringify(result))
              }}
            />
            <RouteButton
              label="Spawn 10 JSContexts"
              onPress={() => {
                const baseline = CoreModule.getMemoryMB()
                const result = (CoreModule as unknown as {jscSpawnAndMeasure: (n: number, b: number) => unknown}).jscSpawnAndMeasure(10, baseline)
                // eslint-disable-next-line no-console
                console.log("STRESS: jsc-spike", JSON.stringify(result))
              }}
            />
            <RouteButton
              label="Spawn 50 JSContexts"
              onPress={() => {
                const baseline = CoreModule.getMemoryMB()
                const result = (CoreModule as unknown as {jscSpawnAndMeasure: (n: number, b: number) => unknown}).jscSpawnAndMeasure(50, baseline)
                // eslint-disable-next-line no-console
                console.log("STRESS: jsc-spike", JSON.stringify(result))
              }}
            />
            <RouteButton
              label="Kill all JSContexts"
              onPress={() => {
                ;(CoreModule as unknown as {jscKillAll: () => void}).jscKillAll()
                // eslint-disable-next-line no-console
                console.log("STRESS: jsc-killed-all")
              }}
            />
          </Group>
        </View>
      </ScrollView>
    </Screen>
  )
}
