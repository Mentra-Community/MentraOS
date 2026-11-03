import {engine, useApps, useStart, useStop} from "@mentra/engine"
import {StatusBar} from "expo-status-bar"
import {useCallback, useEffect, useState} from "react"
import {SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View} from "react-native"

import {startEngineRuntime} from "./src/engineRuntime"
import {ActionButton, Section, StatusRow} from "./src/ui"
import {useLog} from "./src/useLog"

// This example host targets Even Realities G2. A real OEM host would let the
// user pick from the models it supports; DeviceModel is a plain string union,
// so the literal is all the engine needs.
const GLASSES_MODEL = "Even Realities G2"

type ScanResult = ReturnType<typeof engine.pairing.searchResults>[number]

export default function App() {
  const logger = useLog()
  const {run, log, clear, entries} = logger

  const apps = useApps()
  const start = useStart()
  const stop = useStop()
  const running = apps.filter((app) => app.running).map((app) => app.packageName)

  const [glassesState, setGlassesState] = useState<string>(() => engine.glasses.status().state)
  const [scanning, setScanning] = useState(false)
  const [devices, setDevices] = useState<ScanResult[]>([])
  const [devUrl, setDevUrl] = useState("")

  // Configure + start the engine runtime once (the OEM bootstrap contract);
  // demo listeners feed the console below.
  useEffect(() => {
    let cleanup: (() => void) | undefined
    let unmounted = false
    startEngineRuntime(log)
      .then((unsubscribe) => {
        if (unmounted) unsubscribe()
        else cleanup = unsubscribe
      })
      .catch((error) => logger.logError(`engine start failed: ${String(error)}`))
    return () => {
      unmounted = true
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot bootstrap
  }, [])

  // Live read-models: glasses connection and scan progress/results. useApps()
  // already projects each miniapp's running state.
  useEffect(() => engine.glasses.onStatus((s) => setGlassesState(s.state)), [])
  useEffect(() => engine.pairing.onScanning(setScanning), [])
  useEffect(() => engine.pairing.onFound(setDevices), [])

  const connected = glassesState === "connected"
  const firstApp = apps[0]

  // --- Pairing ---
  const scanForGlasses = useCallback(async () => {
    // Without BLUETOOTH_SCAN/CONNECT (Android 12+) the OS silently withholds
    // scan results — the native scan "starts" but never reports a device, so
    // the button spins on "Scanning…" forever with no error. Request first.
    const granted = await run("permissions.request(bluetooth)", () => engine.permissions.request("bluetooth"))
    if (!granted) {
      logger.logError("Bluetooth permission denied — can't scan for glasses.")
      return
    }
    // Mark the model as the pending selection (the scan-entry write of the
    // two-phase identity contract), then start scanning. Results stream into
    // `devices` via onFound.
    engine.pairing.markPendingSelection(GLASSES_MODEL)
    await run(`scan(${GLASSES_MODEL})`, () => engine.pairing.scan(GLASSES_MODEL))
  }, [run, logger])

  const pairDevice = useCallback(
    async (device: ScanResult) => {
      // pair() marks pending only; native promotes to default on pairing
      // success. Watch the glasses status row flip to "connected".
      await run(`pair(${device.name})`, () => engine.pairing.pair(device))
    },
    [run],
  )

  const reconnect = useCallback(async () => {
    await run("glasses.connectDefault()", () => engine.glasses.connectDefault())
  }, [run])

  const disconnect = useCallback(async () => {
    await run("glasses.disconnect()", () => engine.glasses.disconnect())
  }, [run])

  // --- Miniapps ---
  const loadMiniapp = useCallback(async () => {
    const trimmed = devUrl.trim()
    if (!trimmed) {
      logger.logError("Enter the dev URL your miniapp is served from (e.g. http://192.168.x.x:8080).")
      return
    }
    // Called directly (not via run) to read the typed {ok} result.
    log(`▶ dev.loadDevMiniapp(${trimmed})`)
    try {
      const result = await engine.dev.loadDevMiniapp(trimmed)
      if (result.ok) log(`✓ loaded ${result.name} (${result.packageName})`)
      else logger.logError(`✗ load failed: ${result.error}`)
    } catch (err) {
      logger.logError(`✗ load failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [devUrl, log, logger])

  const startMiniapp = useCallback(async () => {
    if (!firstApp) {
      logger.logError("No miniapp registered — load one by URL above first.")
      return
    }
    if (!connected) log("Note: no glasses connected, so the miniapp has nowhere to render.")
    await run(`start(${firstApp.packageName})`, () => start(firstApp))
  }, [firstApp, connected, run, start, log, logger])

  const stopMiniapp = useCallback(async () => {
    const target = running[0] ?? firstApp?.packageName
    if (!target) {
      logger.logError("No running miniapp to stop.")
      return
    }
    await run(`stop(${target})`, () => stop(target))
  }, [running, firstApp, run, stop, logger])

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Example OEM App</Text>
        <Text style={styles.subtitle}>Mentra Engine SDK — pair glasses & run a miniapp</Text>

        <Section title="State" subtitle="From @mentra/engine">
          <StatusRow label="Glasses" value={glassesState} busy={scanning} />
          <StatusRow label="Registered miniapps" value={String(apps.length)} />
          <StatusRow label="Running miniapps" value={String(running.length)} />
        </Section>

        <Section title="Pair glasses" subtitle={`engine.pairing / engine.glasses — ${GLASSES_MODEL}`}>
          {connected ? (
            <ActionButton label="Disconnect" onPress={disconnect} variant="danger" />
          ) : (
            <>
              <ActionButton
                label={scanning ? "Scanning…" : "Scan for glasses"}
                onPress={scanForGlasses}
                disabled={scanning}
              />
              {devices.map((device) => (
                <ActionButton key={device.id} label={`Pair: ${device.name}`} onPress={() => pairDevice(device)} />
              ))}
              <ActionButton label="Reconnect last paired" onPress={reconnect} />
            </>
          )}
        </Section>

        <Section title="Miniapps" subtitle="Load a dev miniapp by URL, then start / stop">
          <TextInput
            style={styles.input}
            value={devUrl}
            onChangeText={setDevUrl}
            placeholder="http://192.168.x.x:8080"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <ActionButton label="Load miniapp from URL" onPress={loadMiniapp} />
          <ActionButton label="Start miniapp" onPress={startMiniapp} />
          <ActionButton label="Stop miniapp" onPress={stopMiniapp} />
        </Section>

        <Section title="Console" subtitle="Most recent calls and results">
          <ActionButton label="Clear log" onPress={clear} />
          <View style={styles.console}>
            {entries.length === 0 ? (
              <Text style={styles.consoleEmpty}>Tap a button to see results here.</Text>
            ) : (
              entries.map((e) => (
                <Text key={e.id} style={[styles.consoleLine, e.level === "error" && styles.consoleError]}>
                  <Text style={styles.consoleTime}>{e.time} </Text>
                  {e.text}
                </Text>
              ))
            )}
          </View>
        </Section>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f3f4f6",
  },
  scroll: {
    paddingTop: 12,
    paddingBottom: 48,
  },
  title: {
    fontSize: 26,
    fontWeight: "800",
    color: "#111827",
    marginHorizontal: 16,
  },
  subtitle: {
    fontSize: 14,
    color: "#6b7280",
    marginHorizontal: 16,
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#111827",
    backgroundColor: "#f9fafb",
    marginBottom: 8,
  },
  console: {
    backgroundColor: "#0f172a",
    borderRadius: 10,
    padding: 12,
    minHeight: 80,
  },
  consoleEmpty: {
    color: "#94a3b8",
    fontSize: 13,
    fontStyle: "italic",
  },
  consoleLine: {
    color: "#e2e8f0",
    fontSize: 12,
    fontFamily: "Courier",
    marginBottom: 4,
  },
  consoleError: {
    color: "#f87171",
  },
  consoleTime: {
    color: "#64748b",
  },
})
