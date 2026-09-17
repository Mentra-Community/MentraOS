import {useMemo} from "react"
import {View} from "react-native"

import {SETTINGS, useSetting} from "@mentra/engine"
import type {MicRmsEvent, MicTuning, MicTuningStateEvent} from "@mentra/bluetooth-sdk-internal"

import {Text} from "@/components/ignite"
import SelectSetting from "@/components/settings/SelectSetting"
import SliderSetting from "@/components/settings/SliderSetting"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"

/**
 * Firmware defaults, mirrored from center_mic_vad_get_default_config and
 * CODEC_SADC_VOL. A slider has to show something before the glasses answer,
 * and "what the firmware would do" is the honest placeholder.
 */
const DEFAULTS = {
  gain: 15,
  open: 1350,
  close: 945,
  attack: 3,
  hang: 80,
  sp_open: 2900,
  sp_close: 1600,
  sp_hold: 30,
} as const

/** codec_adc_vol[]: index -> dB. Index 0 is mute and is not offered. */
const GAIN_DB = [-99, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 32]

const FRAME_MS = 10

type Props = {
  /** Latest sr_micrms sample, or null before the glasses have reported one. */
  rms: MicRmsEvent | null
  /** What the glasses say is actually in force, post-clamp. */
  applied: MicTuningStateEvent | null
}

export function MicrophoneTuningSettings({rms, applied}: Props) {
  const {theme} = useAppTheme()
  const [desired, setDesired] = useSetting<MicTuning | null>(SETTINGS.mic_tuning_desired.key)

  const current = useMemo<Required<MicTuning>>(() => {
    const merged: Record<string, number> = {...DEFAULTS}
    for (const [key, value] of Object.entries(desired ?? {})) {
      if (typeof value === "number") merged[key] = value
    }
    return merged as Required<MicTuning>
  }, [desired])

  const update = (patch: Partial<MicTuning>) => {
    void setDesired({...(desired ?? {}), ...patch})
  }

  // close is edited as a percentage of open: the firmware refuses close >= open
  // and silently rewrites it, so a raw pair of sliders would fight the clamp.
  const closePercent = Math.round((current.close / Math.max(1, current.open)) * 100)

  const gateLabel = rms?.gateOpen
    ? translate("microphoneSettings:tuningGateOpen")
    : translate("microphoneSettings:tuningGateClosed")

  const openForBar = applied?.open ?? current.open
  const barFraction = rms ? Math.min(1, rms.rms / Math.max(1, openForBar * 1.5)) : 0
  const thresholdFraction = Math.min(1, openForBar / Math.max(1, openForBar * 1.5))

  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text tx="microphoneSettings:tuningLevel" className="text-text text-base font-semibold" />
        {rms ? (
          <>
            <View className="flex-row items-baseline justify-between">
              <Text text={String(rms.rms)} className="text-foreground text-2xl font-semibold" />
              <Text
                text={gateLabel}
                style={{color: rms.gateOpen ? theme.colors.tint : theme.colors.textDim}}
                className="text-sm font-medium"
              />
            </View>
            {/* Level against the open threshold: the only way to pick a
                threshold without guessing. */}
            <View className="h-2 w-full rounded-full overflow-hidden" style={{backgroundColor: theme.colors.border}}>
              <View
                style={{
                  width: `${Math.round(barFraction * 100)}%`,
                  backgroundColor: rms.gateOpen ? theme.colors.tint : theme.colors.textDim,
                }}
                className="h-2"
              />
            </View>
            <View className="w-full">
              <View
                style={{
                  marginLeft: `${Math.round(thresholdFraction * 100)}%`,
                  width: 2,
                  height: 8,
                  backgroundColor: theme.colors.text,
                }}
              />
            </View>
            {rms.speakerElevated && (
              <Text
                tx="microphoneSettings:tuningSpeakerElevated"
                style={{color: theme.colors.textDim}}
                className="text-xs"
              />
            )}
          </>
        ) : (
          <Text
            tx="microphoneSettings:tuningWaiting"
            style={{color: theme.colors.textDim}}
            className="text-sm"
          />
        )}
      </View>

      <Group title={translate("microphoneSettings:tuningGainLabel")}>
        <SelectSetting
          label={translate("microphoneSettings:tuningGainLabel")}
          description={translate("microphoneSettings:tuningGainSubtitle")}
          value={String(current.gain)}
          options={GAIN_DB.map((db, index) => ({
            label: index === DEFAULTS.gain ? `+${db} dB (default)` : `${db >= 0 ? "+" : ""}${db} dB`,
            value: String(index),
          })).slice(1)}
          onValueChange={(value) => update({gain: Number(value)})}
          isFirst
          isLast
        />
      </Group>

      <Group title={translate("microphoneSettings:tuningThresholds")}>
        <SliderSetting
          label={translate("microphoneSettings:tuningOpen")}
          subtitle={appliedHint(applied?.open, current.open, translate("microphoneSettings:tuningOpenSubtitle"))}
          value={current.open}
          min={300}
          max={6000}
          onValueChange={() => {}}
          onValueSet={(value) => update({open: value, close: Math.round((value * closePercent) / 100)})}
          isFirst
        />
        <SliderSetting
          label={translate("microphoneSettings:tuningClose")}
          subtitle={appliedHint(applied?.close, current.close, translate("microphoneSettings:tuningCloseSubtitle"))}
          value={closePercent}
          min={30}
          max={95}
          onValueChange={() => {}}
          onValueSet={(percent) => update({close: Math.round((current.open * percent) / 100)})}
        />
        <SliderSetting
          label={translate("microphoneSettings:tuningAttack")}
          subtitle={appliedHint(msOf(applied?.attack), msOf(current.attack))}
          value={current.attack * FRAME_MS}
          min={10}
          max={300}
          onValueChange={() => {}}
          onValueSet={(ms) => update({attack: framesOf(ms)})}
        />
        <SliderSetting
          label={translate("microphoneSettings:tuningHangover")}
          subtitle={appliedHint(
            msOf(applied?.hang),
            msOf(current.hang),
            translate("microphoneSettings:tuningHangoverSubtitle"),
          )}
          value={current.hang * FRAME_MS}
          min={100}
          max={2000}
          onValueChange={() => {}}
          onValueSet={(ms) => update({hang: framesOf(ms)})}
          isLast
        />
      </Group>

      <Group title={translate("microphoneSettings:tuningSpeakerSection")}>
        <SliderSetting
          label={translate("microphoneSettings:tuningSpeakerOpen")}
          subtitle={appliedHint(applied?.sp_open, current.sp_open)}
          value={current.sp_open}
          min={500}
          max={8000}
          onValueChange={() => {}}
          onValueSet={(value) => update({sp_open: value})}
          isFirst
        />
        <SliderSetting
          label={translate("microphoneSettings:tuningSpeakerClose")}
          subtitle={appliedHint(applied?.sp_close, current.sp_close)}
          value={current.sp_close}
          min={0}
          max={8000}
          onValueChange={() => {}}
          onValueSet={(value) => update({sp_close: value})}
        />
        <SliderSetting
          label={translate("microphoneSettings:tuningSpeakerHold")}
          subtitle={appliedHint(msOf(applied?.sp_hold), msOf(current.sp_hold))}
          value={current.sp_hold * FRAME_MS}
          min={0}
          max={2000}
          onValueChange={() => {}}
          onValueSet={(ms) => update({sp_hold: framesOf(ms)})}
          isLast
        />
      </Group>

      <Group>
        <RouteButton
          label={translate("microphoneSettings:tuningReset")}
          onPress={() => void setDesired(null)}
        />
      </Group>
    </View>
  )
}

function framesOf(ms: number): number {
  return Math.max(0, Math.round(ms / FRAME_MS))
}

function msOf(frames: number | undefined): number | undefined {
  return frames === undefined ? undefined : frames * FRAME_MS
}

/**
 * The firmware clamps what it is sent, so the value on the glasses can differ
 * from the one on screen. Say so rather than letting the slider quietly lie.
 */
function appliedHint(
  applied: number | undefined,
  requested: number | undefined,
  base?: string,
): string | undefined {
  if (applied === undefined || applied === requested) return base
  const note = `${translate("microphoneSettings:tuningApplied")}: ${applied}`
  return base ? `${base} ${note}` : note
}
