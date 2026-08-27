import React, { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Line, Path, Polyline } from "react-native-svg";
import {
  useMentraLiveOta,
  type MentraLiveOtaFlowPage,
} from "@mentra/engine/ota";

import { Header } from "../components/Header";
import { colors } from "../components/theme";
import {
  otaPresentation,
  type CustomOtaAction,
  type CustomOtaButton,
} from "./otaPresentation";

export type CustomMentraLiveOtaFlowProps = {
  deviceName?: string;
  initialPage?: MentraLiveOtaFlowPage;
  initializeRuntime?: boolean;
  onFinished: () => void;
  onOpenWifiSetup: () => void;
};

const toneColors = {
  active: { accent: colors.greenPrimary, wash: "rgba(22,163,74,0.10)" },
  danger: { accent: colors.red, wash: "rgba(255,59,48,0.08)" },
  neutral: { accent: colors.muted, wash: "rgba(15,42,29,0.05)" },
  success: { accent: colors.greenDeep, wash: "rgba(52,199,89,0.12)" },
};

export function CustomMentraLiveOtaFlow({
  deviceName = "Mentra Live",
  initialPage = "check",
  initializeRuntime = true,
  onFinished,
  onOpenWifiSetup,
}: CustomMentraLiveOtaFlowProps) {
  const controller = useMentraLiveOta({
    initialPage,
    initializeRuntime,
    onFinished,
    onOpenWifiSetup,
  });
  const presentation = useMemo(
    () => otaPresentation(controller.state, deviceName),
    [controller.state, deviceName],
  );
  const palette = toneColors[presentation.tone];

  const runAction = (action: CustomOtaAction) => {
    controller[action]();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <Header title="Software Update" />
      <View style={styles.page} testID="custom-mentra-live-ota-flow">
        <ScrollView
          contentContainerStyle={styles.centerContent}
          showsVerticalScrollIndicator={false}
          style={styles.contentScroll}
        >
          <StatusIcon
            accent={palette.accent}
            tone={presentation.tone}
            wash={palette.wash}
          />
          <Text style={styles.title}>{presentation.title}</Text>
          {presentation.message ? (
            <Text style={styles.message}>{presentation.message}</Text>
          ) : null}

          {presentation.versionLabel ? (
            <View style={styles.versionBadge}>
              <Text selectable style={styles.versionLabel}>
                {presentation.versionLabel}
              </Text>
            </View>
          ) : null}

          {presentation.progress !== undefined ? (
            <View style={styles.progressBlock}>
              <Text style={[styles.progressValue, { color: palette.accent }]}>
                {Math.round(presentation.progress)}%
              </Text>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: palette.accent,
                      width: `${Math.min(Math.max(presentation.progress, 0), 100)}%`,
                    },
                  ]}
                />
              </View>
            </View>
          ) : null}

          {presentation.indeterminate ? (
            <ActivityIndicator color={palette.accent} size="large" />
          ) : null}

          {presentation.detail ? (
            <Text style={styles.detail}>{presentation.detail}</Text>
          ) : null}

          {presentation.changelogs?.map((entry) => (
            <View key={entry.version} style={styles.changelogEntry}>
              <Text selectable style={styles.changelogVersion}>
                {entry.version}
              </Text>
              <Text selectable style={styles.changelogBody}>
                {entry.markdown}
              </Text>
            </View>
          ))}
        </ScrollView>

        {presentation.primary || presentation.secondary ? (
          <View style={styles.actions}>
            {presentation.primary ? (
              <ActionButton
                button={presentation.primary}
                onPress={runAction}
                primary
              />
            ) : null}
            {presentation.secondary ? (
              <ActionButton
                button={presentation.secondary}
                onPress={runAction}
              />
            ) : null}
          </View>
        ) : (
          <View style={styles.actionSpacer} />
        )}
      </View>
    </SafeAreaView>
  );
}

function StatusIcon({
  accent,
  tone,
  wash,
}: {
  accent: string;
  tone: keyof typeof toneColors;
  wash: string;
}) {
  return (
    <View style={[styles.iconTile, { backgroundColor: wash }]}>
      <Svg
        fill="none"
        height={28}
        stroke={accent}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.2}
        viewBox="0 0 24 24"
        width={28}
      >
        {tone === "success" ? (
          <>
            <Circle cx={12} cy={12} r={9} />
            <Polyline points="8 12 11 15 16.5 9.5" />
          </>
        ) : tone === "danger" ? (
          <>
            <Circle cx={12} cy={12} r={9} />
            <Line x1={12} x2={12} y1={7.5} y2={13} />
            <Line x1={12} x2={12.01} y1={16.5} y2={16.5} />
          </>
        ) : (
          <>
            <Path d="M12 3v12" />
            <Polyline points="7.5 10.5 12 15 16.5 10.5" />
            <Path d="M5 19h14" />
          </>
        )}
      </Svg>
    </View>
  );
}

function ActionButton({
  button,
  onPress,
  primary = false,
}: {
  button: CustomOtaButton;
  onPress: (action: CustomOtaAction) => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={button.disabled}
      onPress={() => onPress(button.action)}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primaryButton : styles.secondaryButton,
        button.disabled && styles.buttonDisabled,
        pressed && !button.disabled && styles.buttonPressed,
      ]}
      testID={`custom-ota-${button.action}`}
    >
      <Text
        style={primary ? styles.primaryButtonText : styles.secondaryButtonText}
      >
        {button.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.bg, flex: 1 },
  page: { flex: 1, paddingBottom: 18, paddingHorizontal: 24 },
  contentScroll: { flex: 1 },
  centerContent: {
    alignItems: "center",
    flexGrow: 1,
    gap: 16,
    justifyContent: "center",
    paddingVertical: 24,
  },
  iconTile: {
    alignItems: "center",
    borderRadius: 18,
    height: 56,
    justifyContent: "center",
    width: 56,
  },
  title: {
    color: colors.ink,
    fontSize: 21,
    fontWeight: "700",
    letterSpacing: -0.25,
    maxWidth: 420,
    textAlign: "center",
  },
  message: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 420,
    textAlign: "center",
  },
  versionBadge: {
    backgroundColor: toneColors.neutral.wash,
    borderColor: colors.hairline,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  versionLabel: {
    color: colors.ink,
    fontSize: 14,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
    textAlign: "center",
  },
  progressBlock: {
    alignItems: "center",
    gap: 12,
    maxWidth: 420,
    width: "100%",
  },
  progressValue: {
    fontSize: 28,
    fontVariant: ["tabular-nums"],
    fontWeight: "800",
  },
  progressTrack: {
    backgroundColor: colors.hairline,
    borderRadius: 4,
    height: 8,
    overflow: "hidden",
    width: "100%",
  },
  progressFill: { borderRadius: 4, height: 8 },
  detail: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 420,
    textAlign: "center",
  },
  changelogEntry: {
    gap: 8,
    maxWidth: 420,
    width: "100%",
  },
  changelogVersion: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "700",
  },
  changelogBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  actions: { gap: 10 },
  actionSpacer: { height: 48 },
  button: {
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  primaryButton: {
    backgroundColor: colors.greenInk,
    borderColor: colors.greenInk,
  },
  secondaryButton: { backgroundColor: colors.bg, borderColor: "#DBDBDB" },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  primaryButtonText: { color: colors.bg, fontSize: 14, fontWeight: "700" },
  secondaryButtonText: {
    color: colors.inkAlt,
    fontSize: 14,
    fontWeight: "700",
  },
});
