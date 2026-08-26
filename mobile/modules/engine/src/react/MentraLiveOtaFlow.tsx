/* eslint-disable react-native/no-raw-text -- BodyText and PercentText are local Text wrappers. */
import React, {useMemo} from "react"
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native"
import {SafeAreaView} from "react-native-safe-area-context"
import Svg, {Path, Rect} from "react-native-svg"

import {useMentraLiveOta, type MentraLiveOtaController, type MentraLiveOtaFlowPage} from "./useMentraLiveOta"

export type {MentraLiveOtaFlowPage} from "./useMentraLiveOta"

export type MentraLiveOtaFlowTheme = {
  background: string
  border: string
  error: string
  foreground: string
  primary: string
  primaryText: string
  textDim: string
}

export type MentraLiveOtaFlowTranslate = (key: string, options?: Record<string, string>) => string

export type MentraLiveOtaFlowProps = {
  /** Display name used in update copy. */
  deviceName?: string
  /** Entry page. `progress` exists for recovery/deep-link compatibility. */
  initialPage?: MentraLiveOtaFlowPage
  /** Start the OTA-only projections. Full Engine hosts should pass false. */
  initializeRuntime?: boolean
  /** Called after the final check or when the user leaves an optional update. */
  onFinished: () => void
  /** Host-owned Wi-Fi setup for glasses that do not support hotspot OTA. */
  onOpenWifiSetup: () => void
  /** Lets a host coordinate its global connection overlay with OTA progress and firmware restarts. */
  onFirmwareRestartingChange?: (restarting: boolean, progressActive: boolean) => void
  /** Enables the existing developer-only escape hatches. */
  allowDevSkip?: boolean
  /** Enables the existing super-mode interrupted-session escape hatch. */
  superMode?: boolean
  /** Optional host localization. Defaults to the Mentra App English OTA copy. */
  translate?: MentraLiveOtaFlowTranslate
  /** Optional host theme. Both hosts use the same layout and state machine. */
  theme?: Partial<MentraLiveOtaFlowTheme>
  style?: StyleProp<ViewStyle>
}

const DEFAULT_THEME: MentraLiveOtaFlowTheme = {
  background: "#FFFFFF",
  border: "#D7DFDA",
  error: "#C43131",
  foreground: "#0E2C1A",
  primary: "#00B869",
  primaryText: "#FFFFFF",
  textDim: "#66736B",
}

const ENGLISH_COPY: Record<string, string> = {
  "common:continue": "Continue",
  "ota:checkingForUpdates": "Checking for updates",
  "ota:checkingForUpdatesMessage":
    "Connected devices will perform automatic updates. Automatic updates can be disabled in Device Settings",
  "ota:updateAvailable": "{{deviceName}} Update Available",
  "ota:updateConnectWifi": "Connect your {{deviceName}} to WiFi to install the update.",
  "ota:updateDescription":
    "A new update is available for your glasses. We recommend updating now for the best experience.",
  "ota:downgradeAvailable": "{{deviceName}} Version Change Required",
  "ota:downgradeDescription":
    "This app requires an earlier glasses software version. Your photos and videos will be preserved, but glasses settings will be reset and restored automatically after the change.",
  "ota:updateNow": "Update Now",
  "ota:setupWifi": "Setup WiFi",
  "ota:updateLater": "Later",
  "ota:upToDate": "Up To Date",
  "ota:devBuild": "Development Build",
  "ota:devBuildNoOta":
    "This mobile app is a development build, so automatic glasses updates are disabled. Use the developer settings manifest override to update them manually.",
  "ota:noUpdatesAvailable": "Your glasses are running the latest version.",
  "ota:checkFailed": "Check Failed",
  "ota:checkFailedMessage": "Couldn't check for updates. Please check your connection and try again.",
  "ota:updateInfoUnavailable": "Update Info Unavailable",
  "ota:updateInfoUnavailableMessage":
    "Update information for this version of the app is unavailable. Please check the app store for a newer version of the Mentra App.",
  "ota:downgradeDuration": "Your glasses will restart twice — this may take up to 2 minutes.",
  "ota:versionChangeRestarting": "Installing a different version…",
  "ota:versionChangeVerifying": "Verifying your glasses…",
  "ota:versionChangeKeepNearby": "Keep your glasses nearby and connected. They will restart on their own.",
  "ota:versionChangeComplete": "Version Change Complete",
  "ota:versionChangeCompleteMessage":
    "Your glasses are now on the required version. Their settings were reset and are being restored automatically.",
  "ota:versionChangeFirmwarePassComplete": "Firmware updated",
  "ota:versionChangeFirmwarePassCompleteMessage":
    "Your glasses restarted with new firmware. One more step: they'll now continue to the required version.",
}

function defaultTranslate(key: string, options?: Record<string, string>): string {
  let value = ENGLISH_COPY[key] ?? key
  for (const [name, replacement] of Object.entries(options ?? {})) {
    value = value.replaceAll(`{{${name}}}`, replacement)
  }
  return value
}

export function MentraLiveOtaFlow({
  allowDevSkip = typeof __DEV__ !== "undefined" && __DEV__,
  deviceName = "Mentra Live",
  initialPage = "check",
  initializeRuntime = true,
  onFinished,
  onFirmwareRestartingChange,
  onOpenWifiSetup,
  style,
  superMode = false,
  theme,
  translate = defaultTranslate,
}: MentraLiveOtaFlowProps) {
  const colors = useMemo(() => ({...DEFAULT_THEME, ...theme}), [theme])
  const controller = useMentraLiveOta({
    initialPage,
    initializeRuntime,
    onFinished,
    onFirmwareRestartingChange,
    onOpenWifiSetup,
  })

  return (
    <SafeAreaView style={[styles.safeArea, {backgroundColor: colors.background}, style]}>
      <View style={styles.header}>
        <View />
        <MentraMark color={colors.primary} />
      </View>
      <OtaFlowContent
        allowDevSkip={allowDevSkip}
        colors={colors}
        controller={controller}
        deviceName={deviceName}
        superMode={superMode}
        translate={translate}
      />
    </SafeAreaView>
  )
}

function OtaFlowContent({
  allowDevSkip,
  colors,
  controller,
  deviceName,
  superMode,
  translate,
}: {
  allowDevSkip: boolean
  colors: MentraLiveOtaFlowTheme
  controller: MentraLiveOtaController
  deviceName: string
  superMode: boolean
  translate: MentraLiveOtaFlowTranslate
}) {
  const {state} = controller

  if (state.screen === "initializing") {
    return (
      <FlowPage colors={colors} icon="download" title={translate("ota:checkingForUpdates")}>
        <ActivityIndicator size="large" color={colors.foreground} />
      </FlowPage>
    )
  }

  if (state.screen === "checking") {
    return (
      <FlowPage colors={colors} icon="download" title={translate("ota:checkingForUpdates")}>
        <BodyText colors={colors}>{translate("ota:checkingForUpdatesMessage")}</BodyText>
        <ActivityIndicator size="large" color={colors.foreground} />
      </FlowPage>
    )
  }

  if (state.screen === "update_available" || state.screen === "wifi_required") {
    return (
      <FlowPage
        colors={colors}
        icon="download"
        title={translate(state.versionChange ? "ota:downgradeAvailable" : "ota:updateAvailable", {deviceName})}
        actions={
          <>
            <FlowButton
              colors={colors}
              disabled={!state.wifiStatusKnown}
              label={translate(state.screen === "wifi_required" ? "ota:setupWifi" : "ota:updateNow")}
              onPress={state.screen === "wifi_required" ? controller.openWifiSetup : controller.install}
            />
            {state.canDismiss ? (
              <FlowButton colors={colors} label={translate("ota:updateLater")} onPress={controller.finish} secondary />
            ) : null}
            {allowDevSkip && state.updateRequired ? (
              <FlowButton colors={colors} label="Skip (dev only)" onPress={controller.finish} secondary />
            ) : null}
          </>
        }>
        <BodyText colors={colors}>
          {state.screen === "wifi_required"
            ? translate("ota:updateConnectWifi", {deviceName})
            : translate(state.versionChange ? "ota:downgradeDescription" : "ota:updateDescription")}
        </BodyText>
      </FlowPage>
    )
  }

  if (state.screen === "dev_build") {
    return (
      <FlowPage
        actions={<FlowButton colors={colors} label={translate("common:continue")} onPress={controller.finish} />}
        colors={colors}
        icon="settings"
        title={translate("ota:devBuild")}>
        <BodyText colors={colors}>{translate("ota:devBuildNoOta")}</BodyText>
      </FlowPage>
    )
  }

  if (state.screen === "up_to_date") {
    return (
      <FlowPage
        actions={<FlowButton colors={colors} label={translate("common:continue")} onPress={controller.finish} />}
        colors={colors}
        icon="check"
        title={translate("ota:upToDate")}>
        <BodyText colors={colors}>{translate("ota:noUpdatesAvailable")}</BodyText>
      </FlowPage>
    )
  }

  if (state.screen === "update_info_unavailable") {
    return (
      <FlowPage
        actions={<FlowButton colors={colors} label={translate("common:continue")} onPress={controller.finish} />}
        colors={colors}
        icon="alert"
        title={translate("ota:updateInfoUnavailable")}>
        <BodyText colors={colors}>{translate("ota:updateInfoUnavailableMessage")}</BodyText>
      </FlowPage>
    )
  }

  if (state.screen === "check_failed") {
    return (
      <FlowPage
        actions={
          <>
            <FlowButton colors={colors} label="Retry" onPress={controller.retryCheck} />
            {allowDevSkip ? (
              <FlowButton colors={colors} label="Skip (dev only)" onPress={controller.finish} secondary />
            ) : null}
          </>
        }
        colors={colors}
        icon="alert"
        title={translate("ota:checkFailed")}>
        <BodyText colors={colors}>{translate("ota:checkFailedMessage")}</BodyText>
      </FlowPage>
    )
  }

  if (state.versionChangePhase === "restarting" || state.versionChangePhase === "verifying") {
    return (
      <FlowPage
        colors={colors}
        icon="download"
        title={translate(
          state.versionChangePhase === "verifying" ? "ota:versionChangeVerifying" : "ota:versionChangeRestarting",
        )}>
        <ActivityIndicator size="large" color={colors.foreground} />
        <BodyText colors={colors}>{translate("ota:versionChangeKeepNearby")}</BodyText>
        <BodyText colors={colors}>{translate("ota:downgradeDuration")}</BodyText>
      </FlowPage>
    )
  }

  if (state.screen === "starting" || state.screen === "preparing_hotspot") {
    const title =
      state.hotspotPhase === "downloading"
        ? "Downloading update to phone..."
        : state.hotspotPhase === "starting_hotspot"
        ? "Starting glasses hotspot..."
        : state.hotspotPhase === "joining_hotspot"
        ? "Connecting phone to glasses..."
        : "Starting update..."
    return (
      <FlowPage colors={colors} icon="download" title={title}>
        {state.hotspotPhase === "downloading" && state.hotspotArtifactPercent !== null ? (
          <PercentText colors={colors} percent={state.hotspotArtifactPercent} />
        ) : null}
        <ActivityIndicator size="large" color={colors.foreground} />
        <BodyText colors={colors}>Do not disconnect your glasses</BodyText>
      </FlowPage>
    )
  }

  if (state.screen === "updating") {
    return (
      <FlowPage colors={colors} icon="download" title={state.phase === "download" ? "Downloading..." : "Installing..."}>
        {state.installingApkOnly ? (
          <ActivityIndicator size="large" color={colors.foreground} />
        ) : (
          <>
            <PercentText colors={colors} percent={state.progress ?? 0} />
            <View style={[styles.progressTrack, {backgroundColor: colors.border}]}>
              <View
                style={[styles.progressFill, {backgroundColor: colors.primary, width: `${state.progress ?? 0}%`}]}
              />
            </View>
          </>
        )}
        <BodyText colors={colors}>Do not disconnect your glasses</BodyText>
        {state.versionChange && state.phase === "install" ? (
          <BodyText colors={colors}>{translate("ota:downgradeDuration")}</BodyText>
        ) : null}
      </FlowPage>
    )
  }

  if (state.screen === "restarting") {
    return (
      <FlowPage
        actions={
          <FlowButton colors={colors} disabled={state.continueDisabled} label="Continue" onPress={controller.finish} />
        }
        colors={colors}
        icon="check"
        title="Update Installed"
      />
    )
  }

  if (state.screen === "complete") {
    const title = state.versionChangeConverged
      ? translate("ota:versionChangeComplete")
      : state.versionChange
      ? translate("ota:versionChangeFirmwarePassComplete")
      : "Update complete!"
    const message = state.versionChangeConverged
      ? translate("ota:versionChangeCompleteMessage")
      : state.versionChange
      ? translate("ota:versionChangeFirmwarePassCompleteMessage")
      : "Your glasses are up to date."
    return (
      <FlowPage
        actions={
          <FlowButton
            colors={colors}
            label={state.versionChange && !state.versionChangeConverged ? "Continue" : "Done"}
            onPress={controller.finish}
          />
        }
        colors={colors}
        icon="check"
        title={title}>
        <BodyText colors={colors}>{message}</BodyText>
        <ChangelogList changelogs={state.changelogs} colors={colors} />
      </FlowPage>
    )
  }

  if (state.screen === "failed") {
    return (
      <FlowPage
        actions={
          <>
            <FlowButton
              colors={colors}
              label={state.canRetry ? "Retry" : "Done"}
              onPress={state.canRetry ? controller.retryInstall : controller.finish}
            />
            {state.canOpenWifiSetup ? (
              <FlowButton colors={colors} label="Change WiFi" onPress={controller.openWifiSetup} secondary />
            ) : null}
          </>
        }
        colors={colors}
        icon="alert"
        title="Update Failed">
        <BodyText colors={colors}>{state.error?.message}</BodyText>
      </FlowPage>
    )
  }

  return (
    <FlowPage
      actions={
        superMode ? (
          <FlowButton colors={colors} label="Skip (super)" onPress={controller.discard} secondary />
        ) : undefined
      }
      colors={colors}
      icon="bluetooth"
      title="Glasses disconnected">
      <BodyText colors={colors}>Reconnecting...</BodyText>
      <ActivityIndicator size="large" color={colors.foreground} />
    </FlowPage>
  )
}

type FlowPageProps = {
  actions?: React.ReactNode
  children?: React.ReactNode
  colors: MentraLiveOtaFlowTheme
  icon: "alert" | "bluetooth" | "check" | "download" | "settings"
  title: string
}

function FlowPage({actions, children, colors, icon, title}: FlowPageProps) {
  return (
    <View style={styles.page} testID="mentra-live-ota-flow">
      <View style={styles.centerContent}>
        <FlowIcon colors={colors} name={icon} />
        <Text style={[styles.title, {color: colors.foreground}]}>{title}</Text>
        {children}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : <View style={styles.actionSpacer} />}
    </View>
  )
}

function BodyText({children, colors}: {children: React.ReactNode; colors: MentraLiveOtaFlowTheme}) {
  return <Text style={[styles.body, {color: colors.textDim}]}>{children}</Text>
}

function PercentText({colors, percent}: {colors: MentraLiveOtaFlowTheme; percent: number}) {
  return <Text style={[styles.percent, {color: colors.primary}]}>{Math.round(percent)}%</Text>
}

function ChangelogList({
  changelogs,
  colors,
}: {
  changelogs: MentraLiveOtaController["state"]["changelogs"]
  colors: MentraLiveOtaFlowTheme
}) {
  if (changelogs.length === 0) return null
  return (
    <ScrollView contentContainerStyle={styles.changelogContent} style={styles.changelogList}>
      {changelogs.map((entry) => (
        <View key={entry.version} style={styles.changelogEntry}>
          <Text selectable style={[styles.changelogVersion, {color: colors.foreground}]}>
            {entry.version}
          </Text>
          <Text selectable style={[styles.changelogMarkdown, {color: colors.textDim}]}>
            {entry.markdown}
          </Text>
        </View>
      ))}
    </ScrollView>
  )
}

function FlowButton({
  colors,
  disabled = false,
  label,
  onPress,
  secondary = false,
}: {
  colors: MentraLiveOtaFlowTheme
  disabled?: boolean
  label: string
  onPress: () => void
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        {
          backgroundColor: secondary ? colors.background : colors.foreground,
          borderColor: secondary ? colors.border : colors.foreground,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
      testID={`button-${label}`}>
      <Text style={[styles.buttonText, {color: secondary ? colors.foreground : colors.background}]}>{label}</Text>
    </Pressable>
  )
}

function MentraMark({color}: {color: string}) {
  return (
    <Svg width={33} height={18} viewBox="0 0 50 27" fill="none">
      <Rect y={14.8072} width={11.8457} height={11.8457} fill={color} />
      <Path d="M9.36639 0L30.7163 14.8072V26.6529L9.36639 11.8457V0Z" fill={color} />
      <Path d="M28.6501 0L50 14.8072V26.6529L28.6501 11.8457V0Z" fill={color} />
    </Svg>
  )
}

function FlowIcon({colors, name}: {colors: MentraLiveOtaFlowTheme; name: FlowPageProps["icon"]}) {
  const color = name === "alert" || name === "bluetooth" ? colors.error : colors.primary
  const glyph =
    name === "check" ? "✓" : name === "alert" ? "!" : name === "settings" ? "⚙" : name === "bluetooth" ? "⌁" : "↓"
  return <Text style={[styles.icon, {color}]}>{glyph}</Text>
}

const styles = StyleSheet.create({
  safeArea: {flex: 1},
  header: {
    alignItems: "center",
    flexDirection: "row",
    height: 48,
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  page: {flex: 1, paddingBottom: 24, paddingHorizontal: 24},
  centerContent: {alignItems: "center", flex: 1, gap: 16, justifyContent: "center"},
  actionSpacer: {height: 48},
  actions: {gap: 12},
  icon: {fontSize: 64, fontWeight: "500", lineHeight: 72, textAlign: "center"},
  title: {fontSize: 20, fontWeight: "600", textAlign: "center"},
  body: {fontSize: 14, lineHeight: 20, maxWidth: 420, textAlign: "center"},
  percent: {fontSize: 30, fontVariant: ["tabular-nums"], fontWeight: "700"},
  progressTrack: {borderRadius: 4, height: 8, maxWidth: 420, overflow: "hidden", width: "100%"},
  progressFill: {borderRadius: 4, height: 8},
  changelogList: {flexShrink: 1, maxHeight: 260, maxWidth: 420, width: "100%"},
  changelogContent: {gap: 18, paddingVertical: 4},
  changelogEntry: {gap: 8},
  changelogVersion: {fontSize: 16, fontWeight: "600"},
  changelogMarkdown: {fontSize: 14, lineHeight: 20},
  button: {
    alignItems: "center",
    borderRadius: 50,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 20,
  },
  buttonText: {fontSize: 14, fontWeight: "500"},
})
