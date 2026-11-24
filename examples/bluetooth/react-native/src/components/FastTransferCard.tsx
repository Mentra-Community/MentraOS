import React from 'react';
import { PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import BluetoothSdk, {
  type FastLinkStatus,
  type PhotoSize,
  type PhotoSuccessResponseEvent,
} from '@mentra/engine/bluetooth-sdk';
import { colors } from './theme';

/** One photo's trip to the phone, as the SDK reports it. */
type FastPhotoResult = {
  requestId: string;
  size: PhotoSize;
  transport: string;
  bytes: number;
  transferMs: number | null;
  totalMs: number | null;
  error?: string;
};

const SIZES: PhotoSize[] = ['medium', 'max'];

/**
 * Wi-Fi Direct photos (Android): open the fast link, take photos, and see how each one reached
 * the phone and how long it took. With the link closed the same button takes a Bluetooth photo,
 * so the two can be compared on the same scene.
 */
export function FastTransferCard({ connected }: { connected: boolean }) {
  const [status, setStatus] = React.useState<FastLinkStatus>(() => BluetoothSdk.getFastLinkStatus());
  const [size, setSize] = React.useState<PhotoSize>('medium');
  const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState<FastPhotoResult[]>([]);

  React.useEffect(() => {
    const subscription = BluetoothSdk.addListener('fast_link_status', (event) => setStatus(event));
    return () => subscription.remove();
  }, []);

  if (Platform.OS !== 'android') return null;

  const open = status.state === 'open' || status.state === 'opening';

  async function toggleLink() {
    if (open) {
      BluetoothSdk.closeFastLink();
      return;
    }
    const permission =
      Number(Platform.Version) >= 33
        ? PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES
        : PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
    const granted = await PermissionsAndroid.request(permission);
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
      setStatus((current) => ({ ...current, state: 'unavailable', reason: 'permission' }));
      return;
    }
    setStatus(BluetoothSdk.openFastLink());
  }

  async function takePhoto() {
    setBusy(true);
    const requestId = `fast-${Date.now()}`;
    try {
      const response = (await BluetoothSdk.requestPhoto({
        requestId,
        webhookUrl: null,
        authToken: null,
        localFile: true,
        size,
        compress: 'none',
        sound: false,
      })) as PhotoSuccessResponseEvent;
      setResults((current) =>
        [
          {
            requestId,
            size,
            transport: response.transport ?? 'ble',
            bytes: response.fileSizeBytes ?? 0,
            transferMs: response.transferMs ?? null,
            totalMs: response.totalMs ?? null,
          },
          ...current,
        ].slice(0, 8),
      );
    } catch (error) {
      setResults((current) =>
        [
          {
            requestId,
            size,
            transport: '-',
            bytes: 0,
            transferMs: null,
            totalMs: null,
            error: error instanceof Error ? error.message : String(error),
          },
          ...current,
        ].slice(0, 8),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card} testID="fast-transfer-card">
      <Text style={styles.eyebrow}>FAST TRANSFER</Text>
      <Text style={styles.status} testID="fast-transfer-status">
        Wi-Fi Direct: {status.state}
        {status.reason ? ` (${status.reason})` : ''}
        {status.openedAfterMs != null ? `, opened in ${status.openedAfterMs} ms` : ''}
      </Text>
      <Text style={styles.result} testID="fast-transfer-glasses-support">
        {status.glassesSupported
          ? 'These glasses support Wi-Fi Direct.'
          : "These glasses don't support Wi-Fi Direct: use their hotspot."}
      </Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          disabled={!connected}
          onPress={() => void toggleLink()}
          style={[styles.button, !connected && styles.disabled]}
          testID="fast-transfer-toggle">
          <Text style={styles.buttonText}>{open ? 'Close Wi-Fi Direct' : 'Open Wi-Fi Direct'}</Text>
        </Pressable>
        {SIZES.map((option) => (
          <Pressable
            accessibilityRole="button"
            key={option}
            onPress={() => setSize(option)}
            style={[styles.chip, size === option && styles.chipActive]}
            testID={`fast-transfer-size-${option}`}>
            <Text style={styles.chipText}>{option}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={!connected || busy}
        onPress={() => void takePhoto()}
        style={[styles.button, (!connected || busy) && styles.disabled]}
        testID="fast-transfer-take-photo">
        <Text style={styles.buttonText}>{busy ? 'Taking photo…' : 'Take photo'}</Text>
      </Pressable>
      {results.map((result, index) => (
        <Text key={result.requestId} style={styles.result} testID={`fast-transfer-result-${index}`}>
          {result.error
            ? `${result.size}: failed, ${result.error}`
            : `${result.size} via ${result.transport}: ${Math.round(result.bytes / 1024)} KB, ` +
              `transfer ${result.transferMs ?? '?'} ms, total ${result.totalMs ?? '?'} ms`}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 28,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceTintStrong,
    gap: 8,
  },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: colors.muted },
  status: { fontSize: 14, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  button: {
    backgroundColor: colors.greenPrimary,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  buttonText: { color: '#FFFFFF', fontWeight: '600' },
  disabled: { opacity: 0.4 },
  chip: { borderRadius: 12, borderWidth: 1, borderColor: colors.hairline, paddingVertical: 6, paddingHorizontal: 10 },
  chipActive: { backgroundColor: colors.greenSoft },
  chipText: { color: colors.ink },
  result: { fontSize: 13, color: colors.ink, fontVariant: ['tabular-nums'] },
});
