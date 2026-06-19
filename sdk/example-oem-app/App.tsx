import {miniappRunningRegistry, useApps, useStart, useStop} from "@mentra/island"
import {StatusBar} from "expo-status-bar"
import {useCallback, useEffect, useState} from "react"
import {SafeAreaView, ScrollView, StyleSheet, Text, View} from "react-native"

import {ActionButton, Section, StatusRow} from "./src/ui"
import {useLog} from "./src/useLog"

export default function App() {
  const logger = useLog()
  const {run, log, clear, entries} = logger

  const apps = useApps()
  const start = useStart()
  const stop = useStop()
  const [running, setRunning] = useState<string[]>(() => miniappRunningRegistry.getAll())

  useEffect(() => {
    setRunning(miniappRunningRegistry.getAll())
    return miniappRunningRegistry.subscribe(() => setRunning(miniappRunningRegistry.getAll()))
  }, [])

  const firstApp = apps[0]

  const startMiniapp = useCallback(async () => {
    if (!firstApp) {
      logger.logError("No miniapps registered — install one via the island host first.")
      return
    }
    await run(`start(${firstApp.packageName})`, () => start(firstApp))
  }, [firstApp, run, start, logger])

  const stopMiniapp = useCallback(async () => {
    const target = running[0] ?? firstApp?.packageName
    if (!target) {
      logger.logError("No running miniapp to stop.")
      return
    }
    await run(`stop(${target})`, () => stop(target))
  }, [running, firstApp, run, stop, logger])

  const listRunning = useCallback(() => {
    const list = miniappRunningRegistry.getAll()
    log(`Running miniapps (${list.length}): ${list.length ? list.join(", ") : "none"}`)
    log(`Registered miniapps (${apps.length}): ${apps.length ? apps.map((a) => a.packageName).join(", ") : "none"}`)
  }, [apps, log])

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Example OEM App</Text>
        <Text style={styles.subtitle}>Mentra Island SDK — miniapp control</Text>

        <Section title="State" subtitle="From @mentra/island">
          <StatusRow label="Registered" value={String(apps.length)} />
          <StatusRow label="Running" value={String(running.length)} />
        </Section>

        <Section title="Miniapps" subtitle="start / stop / list">
          <ActionButton label="Start miniapp" onPress={startMiniapp} />
          <ActionButton label="Stop miniapp" onPress={stopMiniapp} />
          <ActionButton label="List running miniapps" onPress={listRunning} />
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
