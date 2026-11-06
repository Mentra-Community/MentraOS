import React, { useEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Line, Path, Polyline } from "react-native-svg";
import {
  useMentraLivePairing,
  type MentraLivePairingEntryPage,
} from "@mentra/engine/pairing";

import { Header } from "../components/Header";
import { colors } from "../components/theme";
import {
  pairingPresentation,
  type CustomPairingAction,
  type CustomPairingButton,
  type CustomPairingRow,
} from "./pairingPresentation";

export type CustomMentraLivePairingFlowProps = {
  initialPage?: MentraLivePairingEntryPage;
  initializeRuntime?: boolean;
  /** The person left without pairing. */
  onExit: () => void;
  /** The glasses are paired and the person pressed Done. */
  onFinished: () => void;
};

const toneColors = {
  active: { accent: colors.greenPrimary, wash: "rgba(22,163,74,0.10)" },
  danger: { accent: colors.red, wash: "rgba(255,59,48,0.08)" },
  neutral: { accent: colors.muted, wash: "rgba(15,42,29,0.05)" },
  success: { accent: colors.greenDeep, wash: "rgba(52,199,89,0.12)" },
};

export function CustomMentraLivePairingFlow({
  initialPage = "prep",
  initializeRuntime = true,
  onExit,
  onFinished,
}: CustomMentraLivePairingFlowProps) {
  const controller = useMentraLivePairing({
    initialPage,
    initializeRuntime,
    onExit,
    onFinished,
  });
  const presentation = useMemo(
    () => pairingPresentation(controller.state),
    [controller.state],
  );
  const palette = toneColors[presentation.tone];

  const backRef = useRef(controller.back);
  backRef.current = controller.back;
  useEffect(() => {
    // This app has no navigation stack: Android Back is the page's own back action.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      backRef.current();
      return true;
    });
    return () => subscription.remove();
  }, []);

  const runAction = (action: CustomPairingAction) => {
    controller[action]();
  };

  // Leaving Pair Audio during an attempt unpairs the glasses, so ask first.
  const confirmCancel = () => {
    Alert.alert("Cancel pairing?", "Your glasses will be unpaired from this phone.", [
      { text: "Keep pairing", style: "cancel" },
      {
        text: "Cancel pairing",
        style: "destructive",
        onPress: () =>
          void controller.cancelPairing().then((cancelled) => {
            if (!cancelled) Alert.alert("Pairing could not be cancelled. Please try again.");
          }),
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <Header title="Pair Mentra Live" />
      <View style={styles.page} testID="custom-mentra-live-pairing-flow">
        <ScrollView
          contentContainerStyle={[
            styles.centerContent,
            presentation.rows && styles.topContent,
          ]}
          style={styles.contentScroll}
        >
          <StatusIcon accent={palette.accent} tone={presentation.tone} wash={palette.wash} />
          <Text style={styles.title}>{presentation.title}</Text>
          {presentation.message ? (
            <Text style={styles.message}>{presentation.message}</Text>
          ) : null}
          {presentation.steps ? (
            <View style={styles.steps}>
              {presentation.steps.map((step, index) => (
                <Text key={step} style={styles.step}>
                  {`${index + 1}. ${step}`}
                </Text>
              ))}
            </View>
          ) : null}
          {presentation.rows ? (
            <View style={styles.rows}>
              {presentation.rows.map((row) => (
                <GlassesRow
                  key={row.glasses.id}
                  onPress={() => controller.select(row.glasses)}
                  row={row}
                />
              ))}
            </View>
          ) : null}
          {presentation.indeterminate ? (
            <ActivityIndicator color={palette.accent} size="large" />
          ) : null}
          {presentation.detail ? (
            <Text style={styles.detail}>{presentation.detail}</Text>
          ) : null}
        </ScrollView>

        <View style={styles.actions}>
          {presentation.primary ? (
            <ActionButton button={presentation.primary} onPress={runAction} primary />
          ) : null}
          {presentation.secondary ? (
            <ActionButton button={presentation.secondary} onPress={runAction} />
          ) : null}
          {presentation.confirmCancel ? (
            <ActionButton
              button={{ action: "back", label: "Cancel pairing" }}
              onPress={confirmCancel}
            />
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

function GlassesRow({ onPress, row }: { onPress: () => void; row: CustomPairingRow }) {
  return (
    <Pressable
      accessibilityLabel={`${row.label}, ${row.detail}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.buttonPressed]}
    >
      <Text style={styles.rowLabel}>{row.label}</Text>
      <Text style={row.ready ? styles.rowReady : styles.rowNotReady}>{row.detail}</Text>
    </Pressable>
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
          <Path d="m7 7 10 10-5 5V2l5 5L7 17" />
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
  button: CustomPairingButton;
  onPress: (action: CustomPairingAction) => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress(button.action)}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primaryButton : styles.secondaryButton,
        pressed && styles.buttonPressed,
      ]}
      testID={`custom-pairing-${button.action}`}
    >
      <Text style={primary ? styles.primaryButtonText : styles.secondaryButtonText}>
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
  topContent: {
    justifyContent: "flex-start",
    paddingBottom: 16,
    paddingTop: 12,
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
  detail: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 420,
    textAlign: "center",
  },
  steps: { gap: 8, maxWidth: 420, width: "100%" },
  step: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  rows: { gap: 10, maxWidth: 420, width: "100%" },
  row: {
    backgroundColor: toneColors.neutral.wash,
    borderColor: colors.hairline,
    borderRadius: 14,
    borderWidth: 1,
    gap: 4,
    padding: 16,
  },
  rowLabel: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  rowReady: { color: colors.greenDeep, fontSize: 13 },
  rowNotReady: { color: colors.amber, fontSize: 13 },
  actions: { gap: 10 },
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
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  primaryButtonText: { color: colors.bg, fontSize: 14, fontWeight: "700" },
  secondaryButtonText: {
    color: colors.inkAlt,
    fontSize: 14,
    fontWeight: "700",
  },
});
