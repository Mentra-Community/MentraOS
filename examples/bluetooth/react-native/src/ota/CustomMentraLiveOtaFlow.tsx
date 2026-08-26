import React, {useMemo} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  useMentraLiveOta,
  type MentraLiveOtaFlowPage,
} from '@mentra/engine/ota';

import {colors} from '../components/theme';
import {
  otaPresentation,
  type CustomOtaAction,
  type CustomOtaButton,
} from './otaPresentation';

export type CustomMentraLiveOtaFlowProps = {
  deviceName?: string;
  initialPage?: MentraLiveOtaFlowPage;
  initializeRuntime?: boolean;
  onFinished: () => void;
  onOpenWifiSetup: () => void;
};

const toneColors = {
  active: {accent: colors.greenPrimary, wash: '#EAF8EF'},
  danger: {accent: colors.red, wash: '#FFF0EE'},
  neutral: {accent: colors.muted, wash: '#F1F3F0'},
  success: {accent: colors.greenDeep, wash: '#E7F6EB'},
};

export function CustomMentraLiveOtaFlow({
  deviceName = 'Mentra Live',
  initialPage = 'check',
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
      <View style={styles.header}>
        <View>
          <Text style={styles.overline}>STARTER KIT · CUSTOM UI</Text>
          <Text style={styles.headerTitle}>Mentra Live update</Text>
        </View>
        <View style={[styles.statusDot, {backgroundColor: palette.accent}]} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled">
        <View style={[styles.card, {borderColor: palette.accent}]}>
          <View style={[styles.iconRing, {backgroundColor: palette.wash}]}>
            <Text style={[styles.icon, {color: palette.accent}]}>
              {presentation.tone === 'success'
                ? '✓'
                : presentation.tone === 'danger'
                  ? '!'
                  : '↻'}
            </Text>
          </View>

          <Text style={styles.title}>{presentation.title}</Text>
          <Text style={styles.message}>{presentation.message}</Text>

          {presentation.progress !== undefined ? (
            <View style={styles.progressBlock}>
              <View style={styles.progressRow}>
                <Text style={styles.progressLabel}>Progress</Text>
                <Text style={[styles.progressValue, {color: palette.accent}]}>
                  {Math.round(presentation.progress)}%
                </Text>
              </View>
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
            <View style={[styles.detailBox, {backgroundColor: palette.wash}]}>
              <Text style={styles.detail}>{presentation.detail}</Text>
            </View>
          ) : null}
        </View>
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
      ) : null}
    </SafeAreaView>
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
      style={({pressed}) => [
        styles.button,
        primary ? styles.primaryButton : styles.secondaryButton,
        {opacity: button.disabled ? 0.4 : pressed ? 0.72 : 1},
      ]}
      testID={`custom-ota-${button.action}`}>
      <Text style={primary ? styles.primaryButtonText : styles.secondaryButtonText}>
        {button.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {backgroundColor: '#F6F8F5', flex: 1},
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 18,
  },
  overline: {
    color: colors.greenDeep,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  headerTitle: {color: colors.ink, fontSize: 18, fontWeight: '700', marginTop: 3},
  statusDot: {borderRadius: 8, height: 12, width: 12},
  scrollContent: {flexGrow: 1, justifyContent: 'center', padding: 24},
  card: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderLeftWidth: 5,
    borderRadius: 24,
    gap: 18,
    paddingHorizontal: 24,
    paddingVertical: 34,
    shadowColor: colors.greenInk,
    shadowOffset: {height: 12, width: 0},
    shadowOpacity: 0.1,
    shadowRadius: 28,
    elevation: 5,
  },
  iconRing: {
    alignItems: 'center',
    borderRadius: 36,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  icon: {fontSize: 34, fontWeight: '700', lineHeight: 42},
  title: {color: colors.ink, fontSize: 25, fontWeight: '700', textAlign: 'center'},
  message: {color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center'},
  progressBlock: {gap: 8, maxWidth: 420, width: '100%'},
  progressRow: {flexDirection: 'row', justifyContent: 'space-between'},
  progressLabel: {color: colors.muted, fontSize: 13, fontWeight: '600'},
  progressValue: {fontSize: 16, fontVariant: ['tabular-nums'], fontWeight: '800'},
  progressTrack: {
    backgroundColor: colors.hairline,
    borderRadius: 6,
    height: 10,
    overflow: 'hidden',
  },
  progressFill: {borderRadius: 6, height: 10},
  detailBox: {borderRadius: 14, maxWidth: 420, padding: 14, width: '100%'},
  detail: {color: colors.ink, fontSize: 13, lineHeight: 19, textAlign: 'center'},
  actions: {gap: 10, paddingBottom: 18, paddingHorizontal: 24},
  button: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 20,
  },
  primaryButton: {backgroundColor: colors.greenInk, borderColor: colors.greenInk},
  secondaryButton: {backgroundColor: 'transparent', borderColor: colors.greenInk},
  primaryButtonText: {color: '#FFFFFF', fontSize: 15, fontWeight: '700'},
  secondaryButtonText: {color: colors.greenInk, fontSize: 15, fontWeight: '700'},
});
