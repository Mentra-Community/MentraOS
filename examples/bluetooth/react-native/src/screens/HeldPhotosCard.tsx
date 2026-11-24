import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import BluetoothSdk, { type PhotoStatusEvent } from '@mentra/engine/bluetooth-sdk';
import { colors } from '../components/theme';

/** Shots in one burst: each starts as soon as the glasses wrote the one before. */
const BURST_SIZE = 5;
/** Give up on a shot whose capture never reports. */
const CAPTURE_WAIT_MS = 20_000;

type HeldShot = {
  photoId: string;
  index: number;
  requestedAt: number;
  /** Request to written capture: how long the camera was taken. */
  cameraMs?: number;
  /** Request to preview on the phone. */
  previewMs?: number;
  thumbnailUrl?: string;
  error?: string;
};

type Fetched = { photoId: string; uri: string; ms: number; bytes: number };

function seconds(ms: number | undefined) {
  return ms === undefined ? '…' : `${(ms / 1000).toFixed(1)} s`;
}

function average(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

function newPhotoId(index: number) {
  return `h${Date.now().toString(36)}${index}`;
}

type CardState = {
  shots: HeldShot[];
  busy: 'burst' | 'fetch' | 'release' | null;
  fetched: Fetched | null;
  message: string | null;
};

// Kept outside the component: the app leaves the camera screen when the glasses reconnect
// (an update page, for one), and a burst or fetch still in flight must land in the same list.
let card: CardState = { shots: [], busy: null, fetched: null, message: null };
const listeners = new Set<() => void>();

function setCard(patch: Partial<CardState> | ((current: CardState) => Partial<CardState>)) {
  card = { ...card, ...(typeof patch === 'function' ? patch(card) : patch) };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function update(photoId: string, patch: Partial<HeldShot>) {
  setCard(({ shots }) => ({
    shots: shots.map((shot) => (shot.photoId === photoId ? { ...shot, ...patch } : shot)),
  }));
}

async function takeBurst() {
  setCard({ busy: 'burst', message: null, fetched: null, shots: [] });
  const captured = new Map<string, (failed?: string) => void>();
  const subscription = BluetoothSdk.addListener('photo_status', (event: PhotoStatusEvent) => {
    const done = captured.get(event.requestId);
    if (!done) return;
    if (event.status === 'captured') done();
    else if (event.status === 'failed') done(event.errorCode ?? 'failed');
  });
  const previews: Promise<void>[] = [];
  try {
    for (let index = 1; index <= BURST_SIZE; index++) {
      const photoId = newPhotoId(index);
      const requestedAt = Date.now();
      setCard(({ shots }) => ({ shots: [...shots, { photoId, index, requestedAt }] }));
      const written = new Promise<string | undefined>((resolve) => {
        captured.set(photoId, resolve);
        setTimeout(() => resolve('no capture reported'), CAPTURE_WAIT_MS);
      });
      previews.push(
        BluetoothSdk.requestPhoto({
          requestId: photoId,
          size: 'medium',
          webhookUrl: null,
          authToken: null,
          sound: true,
          deliver: 'thumbnail',
        })
          .then((response) =>
            // A capture whose status the restart lost still gets its preview afterwards.
            update(photoId, {
              previewMs: Date.now() - requestedAt,
              thumbnailUrl: response.thumbnailUrl,
              error: undefined,
            }),
          )
          .catch((error: unknown) =>
            update(photoId, { error: (error as { code?: string }).code ?? String(error) }),
          ),
      );
      // The next shot starts once this capture is written: the camera is free again.
      const failed = await written;
      captured.delete(photoId);
      update(photoId, failed ? { error: failed } : { cameraMs: Date.now() - requestedAt });
    }
  } finally {
    subscription.remove();
  }
  await Promise.all(previews);
  setCard({ busy: null });
}

async function fetchFirst() {
  const first = card.shots.find((shot) => shot.thumbnailUrl);
  if (!first) return;
  setCard({ busy: 'fetch', message: null });
  const started = Date.now();
  try {
    const response = await BluetoothSdk.fetchHeldPhoto({ requestId: first.photoId, localFile: true });
    setCard({
      fetched: {
        photoId: first.photoId,
        uri: response.photoUrl ?? '',
        ms: Date.now() - started,
        bytes: response.fileSizeBytes ?? 0,
      },
    });
  } catch (error) {
    setCard({ message: `Fetch failed: ${(error as { code?: string }).code ?? String(error)}` });
  } finally {
    setCard({ busy: null });
  }
}

async function releaseAll() {
  setCard({ busy: 'release' });
  try {
    await BluetoothSdk.releaseHeldPhotos(null);
    setCard({ shots: [], fetched: null, message: 'Released every held photo on the glasses.' });
  } catch (error) {
    setCard({ message: `Release failed: ${String(error)}` });
  } finally {
    setCard({ busy: null });
  }
}

/**
 * Held photos (`requestPhoto({deliver: 'thumbnail'})`): a burst of shots whose previews come
 * first while the full photos stay on the glasses, then one full photo fetched and the rest
 * released. Shows, per shot, how long the camera was taken and how long the preview took.
 */
export function HeldPhotosCard() {
  const [heldPhotosVersion, setHeldPhotosVersion] = React.useState<number | null>(null);
  const { shots, busy, fetched, message } = React.useSyncExternalStore(subscribe, () => card);

  React.useEffect(() => {
    // Whether these glasses can hold photos: their status has it once version_info arrived,
    // shortly after they connect, so check again for a while.
    let mounted = true;
    let checks = 0;
    const check = () =>
      BluetoothSdk.getGlassesStatus()
        .then((status) => {
          const version = status.heldPhotosVersion ?? 0;
          if (mounted) setHeldPhotosVersion(version);
          return version;
        })
        .catch(() => 0);
    const timer = setInterval(async () => {
      if ((await check()) > 0 || ++checks >= 15) clearInterval(timer);
    }, 2000);
    void check();
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  if (heldPhotosVersion === null) {
    return null;
  }
  if (heldPhotosVersion <= 0) {
    return (
      <View style={styles.card} testID="held-photos-card">
        <Text style={styles.eyebrow}>HELD PHOTOS</Text>
        <Text style={styles.note}>These glasses can't hold photos. Update the glasses software.</Text>
      </View>
    );
  }

  const done = shots.filter((shot) => shot.previewMs !== undefined);
  const cameraAvg = average(shots.flatMap((shot) => (shot.cameraMs === undefined ? [] : [shot.cameraMs])));
  const previewAvg = average(done.map((shot) => shot.previewMs!));
  const failures = shots.filter((shot) => shot.error);
  const canFetch = busy === null && done.some((shot) => shot.thumbnailUrl);

  return (
    <View style={styles.card} testID="held-photos-card">
      <Text style={styles.eyebrow}>HELD PHOTOS</Text>
      <Text style={styles.note}>
        Previews first; the full photos stay on the glasses until fetched or released.
      </Text>
      <View style={styles.row}>
        <Pressable
          testID="held-take-burst"
          accessibilityRole="button"
          disabled={busy !== null}
          onPress={takeBurst}
          style={[styles.button, busy !== null && styles.disabled]}>
          <Text style={styles.buttonText}>Take {BURST_SIZE} held photos</Text>
        </Pressable>
        {busy ? <ActivityIndicator color={colors.greenPrimary} /> : null}
      </View>
      {shots.length > 0 ? (
        <Text style={styles.summary} testID="held-summary">
          {`${done.length} of ${shots.length} previews · camera free after ${seconds(cameraAvg)} average · preview in ${seconds(previewAvg)} average${failures.length ? ` · ${failures.length} failed` : ''}`}
        </Text>
      ) : null}
      <View style={styles.grid}>
        {shots.map((shot) => (
          <View key={shot.photoId} style={styles.shot} testID={`held-shot-${shot.index}`}>
            {shot.thumbnailUrl ? (
              <Image source={{ uri: shot.thumbnailUrl }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.placeholder]} />
            )}
            <Text style={styles.shotText}>
              {shot.error
                ? `#${shot.index} ${shot.error}`
                : `#${shot.index} camera ${seconds(shot.cameraMs)} · preview ${seconds(shot.previewMs)}`}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <Pressable
          testID="held-fetch-first"
          accessibilityRole="button"
          disabled={!canFetch}
          onPress={fetchFirst}
          style={[styles.button, !canFetch && styles.disabled]}>
          <Text style={styles.buttonText}>Fetch first full photo</Text>
        </Pressable>
        <Pressable
          testID="held-release-all"
          accessibilityRole="button"
          disabled={busy !== null}
          onPress={releaseAll}
          style={[styles.button, styles.secondary, busy !== null && styles.disabled]}>
          <Text style={[styles.buttonText, styles.secondaryText]}>Release all</Text>
        </Pressable>
      </View>
      {fetched ? (
        <View testID="held-fetched">
          <Text style={styles.summary}>
            {`Full photo fetched in ${seconds(fetched.ms)}, ${Math.round(fetched.bytes / 1024)} KB`}
          </Text>
          <Image source={{ uri: fetched.uri }} style={styles.full} resizeMode="contain" />
        </View>
      ) : null}
      {message ? <Text style={styles.note}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 28,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceTintStrong,
    gap: 10,
  },
  eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 1.2, color: colors.muted },
  note: { fontSize: 13, color: colors.muted },
  summary: { fontSize: 14, color: colors.ink, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  button: { backgroundColor: colors.greenPrimary, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.greenPrimary },
  secondaryText: { color: colors.greenPrimary },
  disabled: { opacity: 0.4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  shot: { width: '47%', gap: 4 },
  thumb: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12 },
  placeholder: { backgroundColor: colors.hairline },
  shotText: { fontSize: 12, color: colors.ink },
  full: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12, marginTop: 6 },
});
