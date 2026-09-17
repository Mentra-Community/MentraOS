import {useCallback, useEffect, useState} from "react"
import {View} from "react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import type {WearStateEvent, WearTuningEvent} from "@mentra/bluetooth-sdk-internal"
import {DeviceTypes, SETTINGS, useSetting} from "@mentra/engine"

import {Text} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {useAppTheme} from "@/contexts/ThemeContext"

const DEFAULTS = {interval: 300, count: 5, majority: 4} as const

/** Plan presets: Fast (150, 5, 4), Default (300, 5, 4), Sticky (300, 9, 7). */
const PRESETS = {
  fast: {interval: 150, count: 5, majority: 4},
  default: {interval: 300, count: 5, majority: 4},
  sticky: {interval: 300, count: 9, majority: 7},
} as const

type Vote = {interval: number; count: number; majority: number}
type PendingVote = {enabled?: boolean} & Partial<Vote>

/**
 * Super Mode wear-detection commands. Mounting asks the glasses what they
 * are running; Super Settings resets when Super Mode turns off.
 */
export function WearDetectionSettings() {
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [worn, setWorn] = useState<boolean | null>(null)
  const [applied, setApplied] = useState<WearTuningEvent | null>(null)
  const [pending, setPending] = useState<PendingVote | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isMentraLive =
    defaultWearable === DeviceTypes.LIVE || String(defaultWearable || "").includes(DeviceTypes.LIVE)

  const send = useCallback(async (label: string, fn: () => Promise<void> | void) => {
    setError(null)
    try {
      await fn()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(`${label}: ${message}`)
    }
  }, [])

  useEffect(() => {
    if (!isMentraLive) return
    const stateSub = BluetoothSdk.addListener("wear_state", (event: WearStateEvent) => {
      setWorn(event.worn)
    })
    const tuningSub = BluetoothSdk.addListener("wear_tuning", (event: WearTuningEvent) => {
      setApplied(event)
      setPending(null)
    })
    void send("requestWearTuning", () => BluetoothSdk.requestWearTuning())
    void send("queryWearState", () => BluetoothSdk.queryWearState())
    return () => {
      stateSub.remove()
      tuningSub.remove()
    }
  }, [isMentraLive, send])

  const enabled = pending?.enabled ?? applied?.enabled ?? false
  const interval = pending?.interval ?? applied?.interval ?? DEFAULTS.interval
  const count = pending?.count ?? applied?.count ?? DEFAULTS.count
  const majority = pending?.majority ?? applied?.majority ?? DEFAULTS.majority

  const setReporting = (on: boolean) => {
    setPending({enabled: on, interval, count, majority})
    void send("setWearReporting", () => BluetoothSdk.setWearReporting(on))
  }

  const sendVote = (next: Vote) => {
    setPending({enabled, ...next})
    void send("setWearTuning", () => BluetoothSdk.setWearTuning(next.interval, next.count, next.majority))
  }

  if (!isMentraLive) {
    return (
      <Group title="Wear detection">
        <Text
          text="Connect Mentra Live to tune wear detection."
          style={{color: theme.colors.textDim}}
          className="text-sm"
        />
      </Group>
    )
  }

  return (
    <View className="gap-3">
      <Group title="Wear detection">
        <View className="gap-1 px-1 pb-1">
          <Text text={`reporting: ${enabled ? "on" : "off"}`} className="text-text text-sm" />
          <Text text={`worn: ${worn === null ? "unknown" : worn ? "yes" : "no"}`} className="text-text text-sm" />
          <Text
            text={`applied: ${interval}ms x ${count}, majority ${majority} (gen ${applied?.generation ?? 0})`}
            style={{color: theme.colors.textDim}}
            className="text-sm"
          />
          {applied && !applied.accepted && (
            <Text text="rejected" style={{color: theme.colors.tint}} className="text-sm font-medium" />
          )}
          {error && <Text text={error} style={{color: theme.colors.tint}} className="text-sm font-medium" />}
        </View>
        <RouteButton label="Query state" onPress={() => void send("queryWearState", () => BluetoothSdk.queryWearState())} />
        <RouteButton label="Reporting ON" onPress={() => setReporting(true)} />
        <RouteButton label="Reporting OFF" onPress={() => setReporting(false)} />
        <RouteButton label="Fast" subtitle="150ms x 5, majority 4" onPress={() => sendVote(PRESETS.fast)} />
        <RouteButton label="Default" subtitle="300ms x 5, majority 4" onPress={() => sendVote(PRESETS.default)} />
        <RouteButton label="Sticky" subtitle="300ms x 9, majority 7" onPress={() => sendVote(PRESETS.sticky)} />
        <RouteButton label="Majority +" onPress={() => sendVote({interval, count, majority: majority + 1})} />
        <RouteButton label="Majority -" onPress={() => sendVote({interval, count, majority: majority - 1})} />
        <RouteButton label="Interval +50" onPress={() => sendVote({interval: interval + 50, count, majority})} />
        <RouteButton label="Interval -50" onPress={() => sendVote({interval: interval - 50, count, majority})} />
        <RouteButton
          label="Reset to firmware defaults"
          onPress={() => {
            setPending({enabled: false, ...DEFAULTS})
            void send("resetWearTuning", () => BluetoothSdk.resetWearTuning())
          }}
        />
      </Group>
    </View>
  )
}
