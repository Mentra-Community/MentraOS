import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { engine } from '@mentra/engine';
import { MiniappView, type MiniappViewStatus } from '@mentra/engine/miniapp-view';
import { colors } from '../components/theme';

const MENTRA_CALL = 'com.mentra.call';
const MENTRA_CALL_URL = 'https://miniapps.mentraglass.com/com.mentra.call/';
// The tab bar floats over the bottom of the screen; the miniapp keeps its controls above it.
const TAB_BAR_CLEARANCE = 96;

let prepared: Promise<void> | null = null;

/** Start the Engine's miniapp runtime once, and install Mentra Call from its published URL. */
function prepareMentraCall(): Promise<void> {
  prepared ??= (async () => {
    engine.configure({
      // Signed out, as the Mentra App is before sign-in: Mentra Call opens, but cannot create or join a meeting.
      auth: {
        getSubjectToken: async () => {
          throw new Error('Not signed in');
        },
      },
      config: { coreUrl: 'https://core.mentraglass.com', runtimeUrl: 'https://runtime.mentraglass.com' },
    });
    await engine.start();
    await engine.miniapps.install(MENTRA_CALL_URL, { source: 'system' });
  })().catch((error) => {
    prepared = null;
    throw error;
  });
  return prepared;
}

/** Mentra Call, running while this tab is shown: mounting opens it, unmounting stops it. */
export function MentraCallScreen() {
  const [installed, setInstalled] = useState(false);
  const [status, setStatus] = useState<MiniappViewStatus>({ state: 'loading', attempt: 0 });

  useEffect(() => {
    let shown = true;
    prepareMentraCall().then(
      () => shown && setInstalled(true),
      (error: Error) => shown && setStatus({ state: 'failed', reason: 'launch', error }),
    );
    return () => {
      shown = false;
      void engine.miniapps.stop(MENTRA_CALL);
    };
  }, []);

  return (
    <View style={styles.root}>
      {installed && (
        <MiniappView
          packageName={MENTRA_CALL}
          safeAreaInsets={{ top: 0, bottom: TAB_BAR_CLEARANCE, left: 0, right: 0 }}
          onStatus={setStatus}
        />
      )}
      {status.state !== 'ready' && (
        <View style={styles.cover}>
          {status.state === 'failed' ? (
            <Text style={styles.error}>
              Mentra Call could not open: {status.reason === 'launch' ? status.error.message : status.reason}
            </Text>
          ) : (
            <ActivityIndicator color={colors.greenInk} />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  cover: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
  error: { color: colors.ink, fontSize: 14, textAlign: 'center' },
});
