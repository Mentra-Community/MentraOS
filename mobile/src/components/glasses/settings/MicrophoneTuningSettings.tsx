import {useCallback, useMemo, useState} from "react"
import {View} from "react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import type {MicRmsEvent, MicTuning, MicTuningStateEvent} from "@mentra/bluetooth-sdk-internal"
import {SETTINGS, useSetting} from "@mentra/engine"

import {Text} from "@/components/ignite"
import {
  applyMicTuningPatch,
  GAIN_DB,
  MIC_TUNING_DEFAULTS as DEFAULTS,
  micTuningOverrides,
  resolveMicTuning,
} from "@/components/glasses/settings/micTuningMath"
import {SettingsCommandButton} from "@/components/glasses/settings/SettingsCommandButton"
import SelectSetting from "@/components/settings/SelectSetting"
import SliderSetting from "@/components/settings/SliderSetting"
import {Group} from "@/components/ui/Group"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"

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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = useCallback(async (label: string, fn: () => Promise<void> | void) => {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(`${label}: ${message}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const current = useMemo<Required<MicTuning>>(() => resolveMicTuning(desired), [desired])

  // One edit can move several fields (gain rescales the thresholds, open drags
  // sp_open, either open keeps its close at ratio). Persist the whole consistent
  // set so the glasses never have to rewrite a neighbour on their own.
  const update = (patch: Partial<MicTuning>) => {
    void setDesired(micTuningOverrides(applyMicTuningPatch(current, patch)))
  }

  // Both close thresholds are edited as a percentage of their open: the
  // firmware refuses close >= open and silently rewrites it, so a raw pair of
  // sliders would fight the clamp.
  const closePercent = Math.round((current.close / Math.max(1, current.open)) * 100)
  const spClosePercent = Math.round((current.sp_close / Math.max(1, current.sp_open)) * 100)

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
        <Text
          tx="microphoneSettings:tuningLevelSubtitle"
          style={{color: theme.colors.textDim}}
          className="text-xs"
        />
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
          onValueSet={(value) => update({open: value})}
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
          subtitle={appliedHint(
            msOf(applied?.attack),
            msOf(current.attack),
            translate("microphoneSettings:tuningAttackSubtitle"),
          )}
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
          subtitle={appliedHint(
            applied?.sp_open,
            current.sp_open,
            translate("microphoneSettings:tuningSpeakerOpenSubtitle"),
          )}
          value={current.sp_open}
          min={500}
          max={8000}
          onValueChange={() => {}}
          onValueSet={(value) => update({sp_open: value})}
          isFirst
        />
        <SliderSetting
          label={translate("microphoneSettings:tuningSpeakerClose")}
          subtitle={appliedHint(
            applied?.sp_close,
            current.sp_close,
            translate("microphoneSettings:tuningSpeakerCloseSubtitle"),
          )}
          value={spClosePercent}
          min={30}
          max={95}
          onValueChange={() => {}}
          onValueSet={(percent) => update({sp_close: Math.round((current.sp_open * percent) / 100)})}
        />
        <SliderSetting
          label={translate("microphoneSettings:tuningSpeakerHold")}
          subtitle={appliedHint(
            msOf(applied?.sp_hold),
            msOf(current.sp_hold),
            translate("microphoneSettings:tuningSpeakerHoldSubtitle"),
          )}
          value={current.sp_hold * FRAME_MS}
          min={0}
          max={2000}
          onValueChange={() => {}}
          onValueSet={(ms) => update({sp_hold: framesOf(ms)})}
          isLast
        />
      </Group>

      {error && <Text text={error} style={{color: theme.colors.tint}} className="text-sm font-medium" />}

      <View className="gap-2">
        <SettingsCommandButton
          label={translate("microphoneSettings:tuningQuery")}
          subtitle={translate("microphoneSettings:tuningQuerySubtitle")}
          disabled={busy}
          onPress={() => void send("requestMicTuningState", () => BluetoothSdk.requestMicTuningState())}
        />
        <SettingsCommandButton
          label={translate("microphoneSettings:tuningReset")}
          subtitle={translate("microphoneSettings:tuningResetSubtitle")}
          disabled={busy}
          onPress={() => {
            // One write. The engine derives mic_tuning = {} from a null desired
            // and DeviceStore always forwards an empty tuning as an explicit
            // reset, so a second direct native write only doubled the traffic.
            // If desired is already null the glasses were reset on connect and
            // native would drop a repeat anyway; read back instead so the
            // "On glasses" hints still refresh.
            void send("resetMicTuning", async () => {
              if (desired === null) {
                await BluetoothSdk.requestMicTuningState()
                return
              }
              await setDesired(null)
            })
          }}
        />
      </View>
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
