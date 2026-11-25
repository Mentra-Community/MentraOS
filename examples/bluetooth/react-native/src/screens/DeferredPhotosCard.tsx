import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import BluetoothSdk, { type LinkState, type PhotoCaptureWithPreview } from '@mentra/engine/bluetooth-sdk';
import { File } from 'expo-file-system';
import { colors } from '../components/theme';
import { jpegSize } from '../jpegSize';

const BURST_SIZE = 5;

type Shot = { capture: PhotoCaptureWithPreview; index: number; cameraMs?: number; previewMs?: number; previewUrl?: string; error?: string };
/** `closed`: not held; `opening`: `link.openFast` pending; `up`/`down`: held, as `link.onChange` last said of the fast link. */
type Link = 'closed' | 'opening' | LinkState['fast'];
type Fetched = { uri: string; ms: number; bytes: number; link: 'up' | 'down' | 'changed'; width?: number; height?: number };
type Card = { shots: Shot[]; busy: boolean; fetching: boolean; fetched?: Fetched; message?: string; link: Link; linkError?: string };

// Outside the component: the app leaves the camera screen when the glasses reconnect, and a burst,
// fetch or held fast link must land in the same card.
let card: Card = { shots: [], busy: false, fetching: false, link: 'closed' };
const listeners = new Set<() => void>();
function setCard(patch: Partial<Card> | ((current: Card) => Partial<Card>)) {
  card = { ...card, ...(typeof patch === 'function' ? patch(card) : patch) };
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
function update(capture: PhotoCaptureWithPreview, patch: Partial<Shot>) {
  setCard(({ shots }) => ({ shots: shots.map((shot) => (shot.capture === capture ? { ...shot, ...patch } : shot)) }));
}
const FETCHED_LINK = { up: 'fast link up (Wi-Fi)', down: 'fast link down (Bluetooth)', changed: 'fast link changed during the fetch' };
const seconds = (ms?: number) => (ms === undefined ? '…' : `${(ms / 1000).toFixed(1)} s`);
const codeOf = (error: unknown) => (error as { code?: string }).code ?? String(error);

/** A photo file's pixel size; its header is in the first 128 KB. */
function photoSize(uri: string) {
  try {
    const file = new File(uri).open();
    try {
      return jpegSize(file.readBytes(Math.min(file.size ?? 0, 128 * 1024))) ?? {};
    } finally {
      file.close();
    }
  } catch {
    return {};
  }
}

/**
 * One capture with its preview: its full photo stays on the glasses (deferred delivery). Resolves once the camera is
 * free again; the preview comes on its own.
 */
async function takeOne(): Promise<void> {
  const requestedAt = Date.now();
  const capture = BluetoothSdk.capturePhoto({ sound: true, preview: true });
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

let unsubscribeFastLink: (() => void) | null = null;

/** Hold the glasses Wi-Fi link: full photos then come over Wi-Fi instead of Bluetooth. */
async function openLink() {
  // While held, the SDK says when the link drops (photos go over Bluetooth meanwhile) and comes back.
  unsubscribeFastLink ??= BluetoothSdk.link.onChange((state) => {
    setCard(({ link }) => (link === 'closed' || link === 'opening' ? {} : { link: state.fast }));
  });
  setCard({ link: 'opening', linkError: undefined });
  try {
    await BluetoothSdk.link.openFast();
    setCard({ link: 'up' });
  } catch (error) {
    setCard({ link: 'closed', linkError: `Fast link did not come up: ${codeOf(error)}` });
  }
}

async function closeLink() {
  setCard({ link: 'closed', linkError: undefined });
  await BluetoothSdk.link.closeFast();
}

/** The first shot's full photo; another shot can be taken while it crosses the link. */
async function fetchFirst() {
  const first = card.shots.find((shot) => shot.previewUrl);
  if (!first) return;
  setCard({ fetching: true, message: undefined });
  const started = Date.now();
  const linkBefore = card.link;
  try {
    const photo = await first.capture.photo();
    // The result does not say which way it came: the SDK uses Wi-Fi while the fast link is up.
    const up = linkBefore === 'up' && card.link === 'up';
    const down = linkBefore !== 'up' && card.link !== 'up';
    const link = up ? 'up' : down ? 'down' : 'changed';
    // Its pixel size, from the JPEG's header: size "auto" is decided by the link it came over.
    setCard({ fetched: { uri: photo.fileUri, ms: Date.now() - started, bytes: photo.size, link, ...photoSize(photo.fileUri) } });
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
 * the rest released. The fast link (`link.openFast`) makes the full photo come over Wi-Fi.
 */
export function DeferredPhotosCard() {
  const [version, setVersion] = React.useState<number | null>(null);
  const { shots, busy, fetching, fetched, message, link, linkError } = React.useSyncExternalStore(subscribe, () => card);

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
        {link === 'closed'
          ? button('Open fast link', () => void openLink(), false, 'fast-link-open')
          : button('Close fast link', () => void closeLink(), link === 'opening', 'fast-link-close')}
        <Text style={styles.summary} testID="fast-link-state">{`Fast link: ${link === 'closed' ? 'closed' : link === 'opening' ? 'opening…' : link}`}</Text>
      </View>
      {linkError ? <Text style={styles.note} testID="fast-link-error">{linkError}</Text> : null}
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
          <Text style={styles.summary}>{`Full photo fetched in ${seconds(fetched.ms)}, ${Math.round(fetched.bytes / 1024)} KB${fetched.width ? `, ${fetched.width} x ${fetched.height}` : ''} · ${FETCHED_LINK[fetched.link]}`}</Text>
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
