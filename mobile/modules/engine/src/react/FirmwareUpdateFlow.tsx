/* eslint-disable react-native/no-raw-text -- Provider copy is translated through the supplied host translator. */
import {useEffect, useState, type ComponentType} from "react"
import {ActivityIndicator, Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle} from "react-native"
import {SafeAreaView} from "react-native-safe-area-context"

import {firmwareUpdates} from "../facades/firmwareUpdates"
import type {FirmwareCopy, FirmwareOpenOptions, FirmwareSnapshot, FirmwareTarget} from "../ota/types"
import {useFirmwareUpdate} from "./useFirmwareUpdate"

export interface FirmwareUpdateTheme {
  background: string
  border: string
  error: string
  foreground: string
  primary: string
  primaryText: string
  textDim: string
}

export interface FirmwareUpdateFlowProps extends FirmwareOpenOptions {
  /** Omit to resolve the paired native device. A model name alone never authorizes an update. */
  target?: FirmwareTarget
  onFinished: () => void
  onOpenWifiSetup?: () => void
  onFirmwareRestartingChange?: (restarting: boolean, progressActive: boolean) => void
  onSnapshot?: (snapshot: FirmwareSnapshot) => void
  theme?: Partial<FirmwareUpdateTheme>
  translate?: (key: string, values?: Record<string, string>) => string
  style?: StyleProp<ViewStyle>
  superMode?: boolean
}

export type FirmwareUpdateViewRegistry = Readonly<
  Record<string, ComponentType<FirmwareUpdateFlowProps & {target: FirmwareTarget}>>
>

const defaultTheme: FirmwareUpdateTheme = {
  background: "#FFFFFF",
  border: "#D7DFDA",
  error: "#C43131",
  foreground: "#0E2C1A",
  primary: "#00B869",
  primaryText: "#FFFFFF",
  textDim: "#66736B",
}

/** Device-neutral host. The composition root supplies any device's specialized presentation. */
export function FirmwareUpdateFlow(props: FirmwareUpdateFlowProps & {views?: FirmwareUpdateViewRegistry}) {
  const [resolved, setResolved] = useState<FirmwareTarget | null>(props.target ?? null)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  const colors = {...defaultTheme, ...props.theme}
  useEffect(() => {
    let observing = true
    setResolved(null)
    setError(null)
    const target = props.target ? Promise.resolve(props.target) : firmwareUpdates.currentTarget()
    void target.then(
      (value) => {
        if (observing) setResolved(value)
      },
      (failure) => {
        if (observing) setError(failure instanceof Error ? failure : new Error(String(failure)))
      },
    )
    return () => {
      observing = false
    }
  }, [props.target?.integrationId, props.target?.deviceId, attempt])

  if (!resolved)
    return (
      <SafeAreaView style={[{flex: 1, backgroundColor: colors.background}, props.style]}>
        <View style={{flex: 1, padding: 24, justifyContent: "center", gap: 20}}>
          {error ? (
            <>
              <Text style={{color: colors.error}}>{error.message}</Text>
              <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)}>
                <Text style={{color: colors.primary}}>{props.translate?.("common:retry") ?? "Retry"}</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator color={colors.primary} />
          )}
        </View>
      </SafeAreaView>
    )
  const CustomView = props.views?.[resolved.integrationId]
  return CustomView ? <CustomView {...props} target={resolved} /> : <ManagedFirmwareView {...props} target={resolved} />
}

function ManagedFirmwareView(props: FirmwareUpdateFlowProps & {target: FirmwareTarget}) {
  const {snapshot, opening, error, perform, retryOpen} = useFirmwareUpdate(props.target, props)
  const colors = {...defaultTheme, ...props.theme}
  const copy = (value: FirmwareCopy): string =>
    value.key && props.translate ? props.translate(value.key, value.values ? {...value.values} : undefined) : value.text
  const view = snapshot.presentation
  useEffect(() => {
    props.onFirmwareRestartingChange?.(["restarting", "verifying"].includes(snapshot.phase), snapshot.active)
  }, [snapshot.phase, snapshot.active, props.onFirmwareRestartingChange])
  useEffect(() => () => props.onFirmwareRestartingChange?.(false, false), [props.onFirmwareRestartingChange])
  return (
    <SafeAreaView style={[{flex: 1, backgroundColor: colors.background}, props.style]}>
      <ScrollView contentContainerStyle={{flexGrow: 1, padding: 24, justifyContent: "center", gap: 20}}>
        <Text accessibilityRole="header" style={{fontSize: 26, fontWeight: "600", color: colors.foreground}}>
          {copy(view.title)}
        </Text>
        {view.message && (
          <Text style={{fontSize: 16, lineHeight: 24, color: colors.textDim}}>{copy(view.message)}</Text>
        )}
        {(view.busy || opening) && <ActivityIndicator color={colors.primary} />}
        {view.progress != null && (
          <Text style={{fontSize: 24, color: colors.foreground}}>{Math.round(view.progress)}%</Text>
        )}
        {error && (
          <Text accessibilityRole="alert" style={{color: colors.error}}>
            {error.message}
          </Text>
        )}
        {view.releaseNotes?.map((note) => (
          <View key={note.version} style={{gap: 8}}>
            <Text style={{fontWeight: "600", color: colors.foreground}}>{note.version}</Text>
            <Text style={{color: colors.textDim}}>{note.markdown}</Text>
          </View>
        ))}
        {error && !view.actions.length && snapshot.safeToRelease && (
          <Pressable onPress={retryOpen} accessibilityRole="button">
            <Text style={{color: colors.primary}}>{props.translate?.("common:retry") ?? "Retry"}</Text>
          </Pressable>
        )}
        {view.actions.map((action) => (
          <Pressable
            key={action.id}
            accessibilityRole="button"
            accessibilityState={{disabled: action.disabled || opening}}
            disabled={action.disabled || opening}
            onPress={() => void perform(action.id)}
            style={{
              padding: 16,
              borderRadius: 24,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: action.secondary ? colors.background : colors.primary,
              opacity: action.disabled || opening ? 0.5 : 1,
            }}>
            <Text
              style={{
                textAlign: "center",
                fontWeight: "600",
                color: action.secondary ? colors.foreground : colors.primaryText,
              }}>
              {copy(action.label)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  )
}
