// Test/benchmark infrastructure. Reachable only via Super Settings →
// Stress Test, which is itself gated behind Super Mode.
//
// JSC memory-spike harness for ongoing measurements on new hardware
// tiers (the WebView-jetsam experiment that settled the architecture
// decision lived here previously — see
// agents/spike-results/jsc-spike-iphone15-release-50ctx.log).

import {useEffect} from "react"
import {ScrollView, View, Text} from "react-native"

import {Header, Screen} from "@/components/ignite"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"
import {useNavigationStore} from "@/stores/navigation"
import {useStressTestStore} from "@/stores/stressTest"
import {buildDummyMiniappHtml} from "@/utils/stressTest/dummyHtml"
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {engine} from "@mentra/engine"
import {miniappRunningRegistry} from "@mentra/engine-host-internal/devtools"

const POLL_MS = 1000

export default function StressTest() {
  const {goBack} = useNavigationStore.getState()
  const {active, residentMB, memWarnCount, start, stop, setResidentMB} = useStressTestStore()

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null
    const tick = () => {
      try {
        const mb = engine.dev.getMemoryMB()
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
        // BluetoothSdk may not be loaded on Android — ignore.
      }
    }
    tick()
    id = setInterval(tick, POLL_MS)
    return () => {
      if (id) clearInterval(id)
    }
  }, [active, memWarnCount, setResidentMB])

  // Keep mountedCount in sync with the registry so jetsam-evicted entries
  // are reflected in the UI.
  useEffect(() => {
    const refresh = () => {
      // setMountedCount(
      //   miniappRunningRegistry.getAll().filter((p) => p.startsWith(DUMMY_PREFIX)).length,
      // )
    }
    refresh()
    const unsub = miniappRunningRegistry.subscribe(refresh)
    return unsub
  }, [])

  // const mountOne = () => {
  //   counterRef.current += 1
  //   const pkg = `${DUMMY_PREFIX}${counterRef.current}`
  //   const uri = realUrl ?? dataUriFor(pkg, mbPerApp)
  //   miniappHost.mount(pkg, uri, {
  //     appName: `Dummy ${counterRef.current}`,
  //   })
  //   // eslint-disable-next-line no-console
  //   console.log(
  //     `STRESS: mount ${JSON.stringify({
  //       pkg,
  //       mode: realUrl ? "url" : "dummy",
  //       url: realUrl,
  //       mb: realUrl ? null : mbPerApp,
  //       at: Date.now(),
  //     })}`,
  //   )
  // }

  // const mountN = (n: number) => {
  //   for (let i = 0; i < n; i += 1) mountOne()
  // }

  // // Autorun: when launched via deeplink with ?autorun=1&mb=X&n=Y, kick off
  // // logging and mount N dummies automatically. The module-level
  // // autoranThisAppLaunch flag guarantees this fires AT MOST ONCE per
  // // app launch even if the deeplink remounts the screen.
  // useEffect(() => {
  //   if (autoranThisAppLaunch) return
  //   if (autoranRef.current) return
  //   if (params.autorun !== "1" && params.autorun !== "true") return
  //   autoranThisAppLaunch = true
  //   autoranRef.current = true
  //   const n = params.n ? Math.max(1, parseInt(params.n, 10)) : 5
  //   const jscN = params.jsc ? Math.max(1, parseInt(params.jsc, 10)) : 0
  //   // eslint-disable-next-line no-console
  //   console.log(`STRESS: autorun ${JSON.stringify({mb: initialMb, n, jscN, at: Date.now()})}`)
  //   start()

  //   // JSC spike mode: skip WebViews entirely, just spawn N JSContexts and
  //   // measure. The native runBenchmark logs everything via Bridge.log →
  //   // syslog, which IS reachable from idevicesyslog (unlike RN's
  //   // console.log in release builds).
  //   if (jscN > 0) {
  //     ;(BluetoothSdk as any).jscRunBenchmark()
  //     return
  //   }

  //   // Stagger the mounts slightly so each WebView has a beat to allocate
  //   // before the next one starts. 200ms is enough for the data: URL to
  //   // begin loading without making the test feel slow.
  //   let i = 0
  //   const id = setInterval(() => {
  //     mountOne()
  //     i += 1
  //     if (i >= n) clearInterval(id)
  //   }, 200)
  //   return () => clearInterval(id)
  //   // eslint-disable-next-line react-hooks/exhaustive-deps
  // }, [])

  // const unmountAll = () => {
  //   miniappRunningRegistry.getAll()
  //     .filter((p) => p.startsWith(DUMMY_PREFIX))
  //     .forEach((p) => miniappHost.unmount(p))
  //   // eslint-disable-next-line no-console
  //   console.log("STRESS: unmount-all")
  // }

  // const terminated = events.filter((e) => e.kind === "terminate").length

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
              onPress={async () => {
                const baseline = engine.dev.getMemoryMB()
                const result = (BluetoothSdk as any).jscSpawnAndMeasure(1, baseline)
                console.log("STRESS: jsc-spike", JSON.stringify(result))
              }}
            />
            <RouteButton
              label="Spawn 10 JSContexts"
              onPress={async () => {
                const baseline = engine.dev.getMemoryMB()
                const result = (BluetoothSdk as any).jscSpawnAndMeasure(10, baseline)
                console.log("STRESS: jsc-spike", JSON.stringify(result))
              }}
            />
            <RouteButton
              label="Spawn 50 JSContexts"
              onPress={async () => {
                const baseline = engine.dev.getMemoryMB()
                const result = (BluetoothSdk as any).jscSpawnAndMeasure(50, baseline)
                console.log("STRESS: jsc-spike", JSON.stringify(result))
              }}
            />
            <RouteButton
              label="Kill all JSContexts"
              onPress={() => {
                (BluetoothSdk as any).jscKillAll()
                console.log("STRESS: jsc-killed-all")
              }}
            />
          </Group>
        </View>
      </ScrollView>
    </Screen>
  )
}
