import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import BluetoothSdk, { type PhotoCapture } from '@mentra/engine/bluetooth-sdk';
import { colors } from '../components/theme';

const BURST_SIZE = 5;

type Shot = { capture: PhotoCapture; index: number; cameraMs?: number; previewMs?: number; previewUrl?: string; error?: string };
type Card = { shots: Shot[]; busy: boolean; fetching: boolean; fetched?: { uri: string; ms: number; bytes: number; width?: number; height?: number }; message?: string };

// Outside the component: the app leaves the camera screen when the glasses reconnect, and a burst
// or fetch still in flight must land in the same list.
let card: Card = { shots: [], busy: false, fetching: false };
const listeners = new Set<() => void>();
function setCard(patch: Partial<Card> | ((current: Card) => Partial<Card>)) {
  card = { ...card, ...(typeof patch === 'function' ? patch(card) : patch) };
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
function update(capture: PhotoCapture, patch: Partial<Shot>) {
  setCard(({ shots }) => ({ shots: shots.map((shot) => (shot.capture === capture ? { ...shot, ...patch } : shot)) }));
}
const seconds = (ms?: number) => (ms === undefined ? '…' : `${(ms / 1000).toFixed(1)} s`);
const codeOf = (error: unknown) => (error as { code?: string }).code ?? String(error);

/**
 * One capture: its full photo stays on the glasses (deferred delivery). Resolves once the camera is
 * free again; the preview comes on its own.
 */
async function takeOne(): Promise<void> {
  const requestedAt = Date.now();
  const capture = BluetoothSdk.capturePhoto({ sound: true });
  setCard(({ shots }) => ({ shots: [...shots, { capture, index: shots.length + 1 }] }));
  // A capture whose status a restart lost still gets its preview afterwards.
  void capture.preview.then(
    (preview) => update(capture, { previewMs: Date.now() - requestedAt, previewUrl: preview.url, error: undefined }),
    (error: unknown) => update(capture, { error: codeOf(error) }),
  );
  try {
    await capture.captured;
    update(capture, { cameraMs: Date.now() - requestedAt });
  } catch (error) {
    update(capture, { error: codeOf(error) });
  }
}

/** Each shot starts as soon as the glasses wrote the one before. */
async function takeBurst() {
  setCard({ busy: true, shots: [], fetched: undefined, message: undefined });
  for (let index = 0; index < BURST_SIZE; index++) await takeOne();
  await Promise.allSettled(card.shots.map((shot) => shot.capture.preview));
  setCard({ busy: false });
}

/** The first shot's full photo; another shot can be taken while it crosses the link. */
async function fetchFirst() {
  const first = card.shots.find((shot) => shot.previewUrl);
  if (!first) return;
  setCard({ fetching: true, message: undefined });
  const started = Date.now();
  try {
    const photo = await first.capture.photo();
    const ms = Date.now() - started;
    setCard({ fetched: { uri: photo.fileUri, ms, bytes: photo.size } });
    // Its pixel size: size "auto" is decided by the link it came over.
    Image.getSize(photo.fileUri, (width, height) => setCard(({ fetched }) => (fetched?.uri === photo.fileUri ? { fetched: { ...fetched, width, height } } : {})));
  } catch (error) {
    setCard({ message: `Fetch failed: ${codeOf(error)}` });
  } finally {
    setCard({ fetching: false });
  }
}

async function releaseAll() {
  await Promise.allSettled(card.shots.map((shot) => shot.capture.release()));
  setCard({ shots: [], fetched: undefined, message: 'Released every photo on the glasses.' });
}

/**
 * Deferred photos (`capturePhoto`, size `auto`): a burst whose previews come first while the full photos stay
 * on the glasses, a capture taken while a full photo is being sent, then one full photo fetched and
 * the rest released.
 */
export function DeferredPhotosCard() {
  const [version, setVersion] = React.useState<number | null>(null);
  const { shots, busy, fetching, fetched, message } = React.useSyncExternalStore(subscribe, () => card);

  React.useEffect(() => {
    // The glasses' status has it once version_info arrived, shortly after they connect.
    let checks = 0;
    const timer = setInterval(() => {
      void BluetoothSdk.getGlassesStatus().then((status) => {
        setVersion(status.deferredPhotosVersion ?? 0);
        if ((status.deferredPhotosVersion ?? 0) > 0 || ++checks >= 15) clearInterval(timer);
      });
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  if (version === null) return null;
  if (version <= 0) {
    return (
      <View style={styles.card} testID="deferred-photos-card">
        <Text style={styles.note}>These glasses send whole photos only. Update the glasses software.</Text>
      </View>
    );
  }
  const done = shots.filter((shot) => shot.previewMs !== undefined);
  const failures = shots.filter((shot) => shot.error).length;
  const button = (label: string, onPress: () => void, disabled: boolean, testID: string) => (
    <Pressable testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.card} testID="deferred-photos-card">
      <Text style={styles.note}>Deferred photos: previews first; the full photos stay on the glasses until fetched or released.</Text>
      <View style={styles.row}>
        {button(`Take ${BURST_SIZE} photos`, takeBurst, busy || fetching, 'deferred-take-burst')}
        {button('Take one more', () => void takeOne(), busy, 'deferred-take-one')}
        {busy || fetching ? <ActivityIndicator color={colors.greenPrimary} /> : null}
      </View>
      {shots.length > 0 ? (
        <Text style={styles.summary}>{`${done.length} of ${shots.length} previews${failures ? ` · ${failures} failed` : ''}`}</Text>
      ) : null}
      <View style={styles.row}>
        {shots.map((shot) => (
          <View key={shot.capture.requestId} style={styles.shot} testID={`deferred-shot-${shot.index}`}>
            {shot.previewUrl ? <Image source={{ uri: shot.previewUrl }} style={styles.photo} /> : null}
            <Text style={styles.note}>
              {shot.error ? `#${shot.index} ${shot.error}` : `#${shot.index} camera ${seconds(shot.cameraMs)} · preview ${seconds(shot.previewMs)}`}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.row}>
        {button('Fetch first full photo', fetchFirst, busy || fetching || !done.length, 'deferred-fetch-first')}
        {button('Release all', releaseAll, busy || fetching, 'deferred-release-all')}
      </View>
      {fetched ? (
        <View testID="deferred-fetched">
          <Text style={styles.summary}>{`Full photo fetched in ${seconds(fetched.ms)}, ${Math.round(fetched.bytes / 1024)} KB${fetched.width ? `, ${fetched.width} x ${fetched.height}` : ''}`}</Text>
          <Image source={{ uri: fetched.uri }} style={styles.photo} resizeMode="contain" />
        </View>
      ) : null}
      {message ? <Text style={styles.note}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { margin: 16, borderRadius: 28, padding: 16, borderWidth: 1, borderColor: colors.hairline, gap: 10 },
  note: { fontSize: 13, color: colors.muted },
  summary: { fontSize: 14, color: colors.ink, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  button: { backgroundColor: colors.greenPrimary, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.4 },
  shot: { width: '47%', gap: 4 },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12 },
});
