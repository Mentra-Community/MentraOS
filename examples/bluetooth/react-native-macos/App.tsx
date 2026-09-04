import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Button, Image, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import BluetoothSdk, {type Device, type OtaStatusEvent} from '@mentra/bluetooth-sdk';
import {useMentraBluetooth} from '@mentra/bluetooth-sdk/react';

export default function App() {
  const session = useMentraBluetooth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [photoUrl, setPhotoUrl] = useState<string>();
  const [lastAction, setLastAction] = useState('');
  const [busy, setBusy] = useState(false);
  const action = useRef<AbortController | null>(null);
  const [otaStatus, setOtaStatus] = useState<OtaStatusEvent>();
  const connected = session.glasses.connected;
  const ready = session.glasses.ready;

  useEffect(() => {
    const photo = BluetoothSdk.addListener('photo_status', event => {
      if (action.current) setLastAction(`Photo: ${event.status}`);
    });
    const ota = BluetoothSdk.addListener('ota_status', event => {
      setOtaStatus(event);
      setLastAction(`OTA: ${event.step_type} ${event.overall_percent}% - ${event.status}`);
    });
    return () => { action.current?.abort(); photo.remove(); ota.remove(); BluetoothSdk.stopScan(); };
  }, []);

  useEffect(() => {
    if (!connected && action.current) {
      action.current.abort();
      action.current = null;
      setBusy(false);
      setLastAction('Disconnected');
    }
  }, [connected]);

  async function run(label: string, operation: (signal: AbortSignal) => Promise<unknown>) {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true);
    setLastAction(label);
    try { await operation(controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) setLastAction(error instanceof Error ? error.message : String(error));
    }
    finally {
      if (!controller.signal.aborted) { action.current = null; setBusy(false); }
    }
  }

  async function scan(signal: AbortSignal) {
    setDevices([]);
    await BluetoothSdk.scan({model: 'Mentra Live', timeoutMs: 10000, onResults: setDevices});
    if (!signal.aborted) setLastAction('Scan complete');
  }

  async function capture(signal: AbortSignal) {
    let url: URL;
    try { url = new URL(webhookUrl); }
    catch { throw new Error('Enter an HTTP or HTTPS webhook URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS webhook URL.');
    setPhotoUrl(undefined);
    const photo = await BluetoothSdk.requestPhoto({webhookUrl: url.href, size: 'medium', authToken: null, compress: 'none', sound: true});
    if (signal.aborted) return;
    setPhotoUrl(photo.photoUrl);
    setLastAction(`Photo uploaded: ${photo.requestId}`);
  }

  return (
    <ScrollView style={styles.window} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Mentra SDK Mac</Text>
      <Text selectable>{connected ? 'Connected' : 'Disconnected'}</Text>
      <View style={styles.row}>
        <Button title="Scan" disabled={busy || connected} onPress={() => void run('Scanning...', scan)} />
        <Button title="Disconnect" disabled={!connected || busy} onPress={() => void run('Disconnecting...', () => BluetoothSdk.disconnect())} />
        {busy && <ActivityIndicator />}
      </View>
      {devices.map(device => (
        <View key={device.id} style={styles.device}>
          <Text selectable>{device.name}</Text>
          <Button title="Connect" disabled={busy || connected} onPress={() => void run('Connecting...', () => BluetoothSdk.connect(device))} />
        </View>
      ))}
      <Text style={styles.heading}>Camera</Text>
      <TextInput style={styles.input} placeholder="Photo webhook URL" value={webhookUrl} onChangeText={setWebhookUrl} autoCapitalize="none" />
      <Button title="Capture photo" disabled={!ready || busy || !webhookUrl.trim()} onPress={() => void run('Capturing...', capture)} />
      {photoUrl && <Image source={{uri: photoUrl}} style={styles.photo} resizeMode="contain" onError={() => setLastAction('The photo uploaded, but its preview could not be loaded.')} />}
      <Text style={styles.heading}>Software Update</Text>
      <Button title="Check OTA" disabled={!ready || busy} onPress={() => void run('Checking for updates...', async signal => {
        const available = await BluetoothSdk.checkForOtaUpdate();
        if (signal.aborted) return;
        setLastAction(available ? 'A glasses update is available' : 'Up to date');
      })} />
      {otaStatus && <Text selectable>{otaStatus.step_type}: {otaStatus.overall_percent}% {otaStatus.error_message ?? ''}</Text>}
      <Text selectable style={styles.action}>{lastAction}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  window: {flex: 1, backgroundColor: '#f7f8fa'},
  content: {padding: 24, gap: 16, maxWidth: 900, width: '100%', alignSelf: 'center'},
  title: {fontSize: 24, fontWeight: '600', color: '#20252b'},
  heading: {fontSize: 17, fontWeight: '600', marginTop: 12, color: '#20252b'},
  row: {flexDirection: 'row', gap: 12, alignItems: 'center'},
  device: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderColor: '#d8dde2', paddingVertical: 8},
  input: {height: 40, paddingHorizontal: 10, borderWidth: 1, borderColor: '#bbc3cb', backgroundColor: '#fff', color: '#20252b', borderRadius: 4},
  photo: {width: '100%', height: 300},
  action: {fontSize: 13, color: '#364452'},
});
