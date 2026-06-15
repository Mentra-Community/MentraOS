import BluetoothSdk, {DeviceModels} from "@mentra/bluetooth-sdk"
import {useMentraBluetooth} from "@mentra/bluetooth-sdk/react"
import {miniappRunningRegistry, useApps, useRefresh, useStart, useStop, useStopAll} from "@mentra/island"
import {StatusBar} from "expo-status-bar"
import {useCallback, useEffect, useState} from "react"
import {SafeAreaView, ScrollView, StyleSheet, Text, View} from "react-native"

import {ActionButton, Section, StatusRow} from "./src/ui"
import {useLog} from "./src/useLog"

export default function App() {
  const logger = useLog()
  const {run, log, clear, entries} = logger

  // ---- Island miniapp control -------------------------------------------
  const apps = useApps()
  const start = useStart()
  const stop = useStop()
  const stopAll = useStopAll()
  const refresh = useRefresh()
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
    await run(`startMiniapp(${firstApp.packageName})`, () => start(firstApp))
  }, [firstApp, run, start, logger])

  const stopMiniapp = useCallback(async () => {
    const target = running[0] ?? firstApp?.packageName
    if (!target) {
      logger.logError("No running miniapp to stop.")
      return
    }
    await run(`stopMiniapp(${target})`, () => stop(target))
  }, [running, firstApp, run, stop, logger])

  const listRunning = useCallback(() => {
    const list = miniappRunningRegistry.getAll()
    log(`Running miniapps (${list.length}): ${list.length ? list.join(", ") : "none"}`)
    log(`Registered miniapps (${apps.length}): ${apps.length ? apps.map((a) => a.packageName).join(", ") : "none"}`)
  }, [apps, log])

  // ---- Bluetooth session (live) -----------------------------------------
  const bt = useMentraBluetooth({onError: (e: unknown) => logger.logError(`status: ${String(e)}`)})
  const connectionState = bt.glasses.connection?.state ?? "unknown"
  const batteryLevel = bt.glasses.connected ? bt.glasses.battery.level : null

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Example OEM App</Text>
        <Text style={styles.subtitle}>Mentra Island SDK + Bluetooth SDK demo</Text>

        <Section title="Connection status" subtitle="Live state from useMentraBluetooth()">
          <StatusRow label="Glasses" value={connectionState} busy={bt.busy} />
          <StatusRow label="Connected" value={bt.glasses.connected ? "yes" : "no"} />
          <StatusRow label="Ready" value={bt.glasses.ready ? "yes" : "no"} />
          <StatusRow label="Battery" value={batteryLevel != null ? `${batteryLevel}%` : "—"} />
          <ActionButton label="Refresh status" onPress={() => run("refresh()", () => bt.refresh())} />
        </Section>

        <Section title="Miniapps" subtitle="@mentra/island registry + store">
          <ActionButton label="Start miniapp" onPress={startMiniapp} />
          <ActionButton label="Stop miniapp" onPress={stopMiniapp} />
          <ActionButton label="List running miniapps" onPress={listRunning} />
          <ActionButton label="Stop all miniapps" onPress={() => run("stopAll()", () => stopAll())} variant="danger" />
          <ActionButton label="Refresh app registry" onPress={() => run("refresh()", () => refresh())} />
        </Section>

        <Section title="Scan & connect" subtitle="Discover and pair glasses">
          <ActionButton
            label="Scan & connect Mentra Live"
            onPress={() =>
              run("scan + connect (Mentra Live)", async () => {
                const devices = await BluetoothSdk.scan(DeviceModels.MentraLive)
                if (!devices[0]) return "no devices found"
                await BluetoothSdk.connect(devices[0])
                return `connected to ${devices[0].name ?? devices[0].address}`
              })
            }
          />
          <ActionButton
            label="Start scan (Mentra Live)"
            onPress={() => run("startScan(MentraLive)", () => BluetoothSdk.startScan(DeviceModels.MentraLive))}
          />
          <ActionButton label="Stop scan" onPress={() => run("stopScan()", () => BluetoothSdk.stopScan())} />
          <ActionButton
            label="Connect default device"
            onPress={() => run("connectDefault()", () => BluetoothSdk.connectDefault())}
          />
          <ActionButton
            label="Cancel connection attempt"
            onPress={() => run("cancelConnectionAttempt()", () => BluetoothSdk.cancelConnectionAttempt())}
          />
          <ActionButton
            label="Disconnect"
            onPress={() => run("disconnect()", () => BluetoothSdk.disconnect())}
            variant="danger"
          />
          <ActionButton
            label="Forget device"
            onPress={() => run("forget()", () => BluetoothSdk.forget())}
            variant="danger"
          />
        </Section>

        <Section title="Display" subtitle="Render text on the glasses">
          <ActionButton
            label="Display text"
            onPress={() =>
              run("displayText('Hello from OEM app')", () => BluetoothSdk.displayText("Hello from OEM app"))
            }
          />
          <ActionButton
            label="Clear display"
            onPress={() => run("clearDisplay()", () => BluetoothSdk.clearDisplay())}
          />
          <ActionButton
            label="Show dashboard"
            onPress={() => run("showDashboard()", () => BluetoothSdk.showDashboard())}
          />
          <ActionButton
            label="Set head-up angle (30°)"
            onPress={() => run("setHeadUpAngle(30)", () => BluetoothSdk.setHeadUpAngle(30))}
          />
          <ActionButton
            label="Disable screen"
            onPress={() => run("setScreenDisabled(true)", () => BluetoothSdk.setScreenDisabled(true))}
          />
          <ActionButton
            label="Enable screen"
            onPress={() => run("setScreenDisabled(false)", () => BluetoothSdk.setScreenDisabled(false))}
          />
        </Section>

        <Section title="Camera & media">
          <ActionButton
            label="Request photo"
            onPress={() =>
              run("requestPhoto()", () =>
                BluetoothSdk.requestPhoto({
                  requestId: "oem-demo-photo",
                  appId: "com.mentra.exampleoemapp",
                  size: "medium",
                  webhookUrl: null,
                  authToken: null,
                  compress: "medium",
                  save: true,
                  sound: true,
                }),
              )
            }
          />
          <ActionButton
            label="Start video recording"
            onPress={() => run("startVideoRecording()", () => BluetoothSdk.startVideoRecording("oem-demo", true, true))}
          />
          <ActionButton
            label="Stop video recording"
            onPress={() => run("stopVideoRecording()", () => BluetoothSdk.stopVideoRecording("oem-demo"))}
          />
          <ActionButton
            label="Query gallery status"
            onPress={() => run("queryGalleryStatus()", () => BluetoothSdk.queryGalleryStatus())}
          />
        </Section>

        <Section title="Microphone & audio">
          <ActionButton
            label="Enable mic"
            onPress={() => run("setMicState(true)", () => BluetoothSdk.setMicState(true))}
          />
          <ActionButton
            label="Disable mic"
            onPress={() => run("setMicState(false)", () => BluetoothSdk.setMicState(false))}
          />
          <ActionButton
            label="Get media volume"
            onPress={() => run("getGlassesMediaVolume()", () => BluetoothSdk.getGlassesMediaVolume())}
          />
          <ActionButton
            label="Set media volume (50%)"
            onPress={() => run("setGlassesMediaVolume(50)", () => BluetoothSdk.setGlassesMediaVolume(50))}
          />
          <ActionButton
            label="Enable VAD"
            onPress={() =>
              run("setVoiceActivityDetectionEnabled(true)", () => BluetoothSdk.setVoiceActivityDetectionEnabled(true))
            }
          />
        </Section>

        <Section title="WiFi & hotspot">
          <ActionButton
            label="Request WiFi scan"
            onPress={() => run("requestWifiScan()", () => BluetoothSdk.requestWifiScan())}
          />
          <ActionButton
            label="Enable hotspot"
            onPress={() => run("setHotspotState(true)", () => BluetoothSdk.setHotspotState(true))}
          />
          <ActionButton
            label="Disable hotspot"
            onPress={() => run("setHotspotState(false)", () => BluetoothSdk.setHotspotState(false))}
          />
        </Section>

        <Section title="Device info & firmware">
          <ActionButton
            label="Request version info"
            onPress={() => run("requestVersionInfo()", () => BluetoothSdk.requestVersionInfo())}
          />
          <ActionButton
            label="Check for OTA update"
            onPress={() => run("checkForOtaUpdate()", () => BluetoothSdk.checkForOtaUpdate())}
          />
          <ActionButton
            label="Get default device"
            onPress={() => run("getDefaultDevice()", () => BluetoothSdk.getDefaultDevice())}
          />
          <ActionButton
            label="Clear default device"
            onPress={() => run("clearDefaultDevice()", () => BluetoothSdk.clearDefaultDevice())}
            variant="danger"
          />
        </Section>

        <Section title="Console" subtitle="Most recent SDK calls and results">
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
