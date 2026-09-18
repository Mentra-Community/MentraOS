import {useCallback, useEffect, useState} from "react"
import {View} from "react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import type {WearStateEvent, WearTuningEvent} from "@mentra/bluetooth-sdk-internal"
import {DeviceTypes, SETTINGS, useSetting} from "@mentra/engine"

import {Text} from "@/components/ignite"
import {SettingsCommandButton} from "@/components/glasses/settings/SettingsCommandButton"
import SelectSetting from "@/components/settings/SelectSetting"
import SliderSetting from "@/components/settings/SliderSetting"
import ToggleSetting from "@/components/settings/ToggleSetting"
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

function clampVote(next: Vote): Vote {
  const count = Math.min(15, Math.max(3, next.count))
  const minMajority = Math.floor(count / 2) + 1
  return {
    interval: Math.min(2000, Math.max(50, next.interval)),
    count,
    majority: Math.min(count, Math.max(minMajority, next.majority)),
  }
}

function presetOf(vote: Vote): string {
  if (vote.interval === PRESETS.fast.interval && vote.count === PRESETS.fast.count && vote.majority === PRESETS.fast.majority) {
    return "fast"
  }
  if (
    vote.interval === PRESETS.default.interval &&
    vote.count === PRESETS.default.count &&
    vote.majority === PRESETS.default.majority
  ) {
    return "default"
  }
  if (
    vote.interval === PRESETS.sticky.interval &&
    vote.count === PRESETS.sticky.count &&
    vote.majority === PRESETS.sticky.majority
  ) {
    return "sticky"
  }
  return "custom"
}

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
  const vote = clampVote({interval, count, majority})
  const preset = presetOf(vote)

  const setReporting = (on: boolean) => {
    setPending({enabled: on, ...vote})
    void send("setWearReporting", () => BluetoothSdk.setWearReporting(on))
  }

  const sendVote = (next: Vote) => {
    const clamped = clampVote(next)
    setPending({enabled, ...clamped})
    void send("setWearTuning", () => BluetoothSdk.setWearTuning(clamped.interval, clamped.count, clamped.majority))
  }

  if (!isMentraLive) {
    return (
      <Text
        text="Connect Mentra Live to tune wear detection."
        style={{color: theme.colors.textDim}}
        className="text-sm"
      />
    )
  }

  return (
    <View className="gap-6">
      <View className="gap-1">
        <Text
          text={`Worn: ${worn === null ? "unknown" : worn ? "yes" : "no"}`}
          className="text-text text-sm"
        />
        <Text
          text="Current voted state from sr_wrst."
          style={{color: theme.colors.textDim}}
          className="text-xs"
        />
        <Text
          text={`Applied: ${vote.interval}ms × ${vote.count}, majority ${vote.majority} (gen ${applied?.generation ?? 0})`}
          style={{color: theme.colors.textDim}}
          className="text-sm"
        />
        {applied && !applied.accepted && (
          <Text text="rejected" style={{color: theme.colors.tint}} className="text-sm font-medium" />
        )}
        {error && <Text text={error} style={{color: theme.colors.tint}} className="text-sm font-medium" />}
      </View>

      <ToggleSetting
        label="Reporting"
        subtitle="RAM-only session switch. Starts off; forgotten on disconnect. Not the NV cs_swit type 1 bit."
        value={enabled}
        onValueChange={setReporting}
        isFirst
        isLast
      />

      <View className="gap-2">
        <SelectSetting
          label="Preset"
          description="Fast polls quicker. Sticky needs more agreeing samples before don/doff flips."
          value={preset}
          options={[
            {label: "Fast (150ms × 5, majority 4)", value: "fast"},
            {label: "Default (300ms × 5, majority 4)", value: "default"},
            {label: "Sticky (300ms × 9, majority 7)", value: "sticky"},
            {label: "Custom", value: "custom"},
          ]}
          onValueChange={(value) => {
            if (value === "custom") return
            sendVote(PRESETS[value as keyof typeof PRESETS])
          }}
          isFirst
          isLast
        />
        <SliderSetting
          label="Interval (ms)"
          subtitle="Poll period, clamped 50–2000 ms. Faster is snappier don/doff and uses more BLE."
          value={vote.interval}
          min={50}
          max={2000}
          onValueChange={() => {}}
          onValueSet={(value) => sendVote({...vote, interval: value})}
          isFirst
        />
        <SliderSetting
          label="Count"
          subtitle="Sliding-window length, clamped 3–15. More samples make the vote stickier."
          value={vote.count}
          min={3}
          max={15}
          onValueChange={() => {}}
          onValueSet={(value) => sendVote({...vote, count: value})}
        />
        <SliderSetting
          label="Majority"
          subtitle="Votes needed to flip. Must be > count/2 and ≤ count. Higher is harder to flip."
          value={vote.majority}
          min={2}
          max={15}
          onValueChange={() => {}}
          onValueSet={(value) => sendVote({...vote, majority: value})}
          isLast
        />
      </View>

      <View className="gap-2">
        <SettingsCommandButton
          label="Query state"
          subtitle="Request the current voted wear state (cs_wrst)."
          onPress={() => void send("queryWearState", () => BluetoothSdk.queryWearState())}
        />
        <SettingsCommandButton
          label="Reset to firmware defaults"
          subtitle="Restore 300 ms × 5, majority 4, and turn reporting off."
          onPress={() => {
            setPending({enabled: false, ...DEFAULTS})
            void send("resetWearTuning", () => BluetoothSdk.resetWearTuning())
          }}
        />
      </View>
    </View>
  )
}
