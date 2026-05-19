import type {Device, HotspotStatus, WifiStatus} from '@mentra/bluetooth-sdk';
import type {GlassesRuntimeState, PhoneSdkRuntimeState} from '@mentra/bluetooth-sdk/react';

export function connectionLabel(glasses: GlassesRuntimeState) {
  return glasses.connection.state.toUpperCase();
}

export function isGlassesConnected(glasses: GlassesRuntimeState) {
  return glasses.connected;
}

export function isGlassesWifiConnected(glasses: GlassesRuntimeState) {
  return glasses.connected && glasses.wifi.state === 'connected';
}

export function connectedWifiStatus(glasses: GlassesRuntimeState): Extract<WifiStatus, {state: 'connected'}> | null {
  return glasses.connected && glasses.wifi.state === 'connected' ? glasses.wifi : null;
}

export function enabledHotspotStatus(glasses: GlassesRuntimeState): Extract<HotspotStatus, {state: 'enabled'}> | null {
  return glasses.connected && glasses.hotspot.state === 'enabled' ? glasses.hotspot : null;
}

export function isHotspotEnabled(glasses: GlassesRuntimeState, fallbackEnabled: boolean) {
  return glasses.connected ? glasses.hotspot.state === 'enabled' : fallbackEnabled;
}

export function isDisconnectedStatus(glasses: GlassesRuntimeState) {
  return glasses.connection.state === 'disconnected';
}

export function deviceLabel(glasses: GlassesRuntimeState) {
  if (!glasses.connected) {
    return 'Mentra Live';
  }
  return glasses.device.bluetoothName || glasses.device.serialNumber || glasses.device.deviceModel || 'Mentra Live';
}

export function supportsDisplay(glasses: GlassesRuntimeState) {
  const model = [
    glasses.connected ? glasses.device.deviceModel : undefined,
    glasses.connected ? glasses.device.bluetoothName : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    model.includes('g1') ||
    model.includes('g2') ||
    model.includes('nex') ||
    model.includes('mach') ||
    model.includes('z100') ||
    model.includes('vuzix') ||
    model.includes('display') ||
    model.includes('frame')
  ) {
    return true;
  }
  if (model.includes('live') || model.includes('r1') || model.includes('ring')) {
    return false;
  }
  return false;
}

export function modelLabel(glasses: GlassesRuntimeState) {
  return glasses.connected ? glasses.device.deviceModel || 'Mentra Live' : 'Mentra Live';
}

export function batteryLevel(glasses: GlassesRuntimeState) {
  return glasses.connected && glasses.battery.level !== null ? Math.min(glasses.battery.level, 100) : null;
}

export function batteryLabel(glasses: GlassesRuntimeState) {
  const level = batteryLevel(glasses);
  if (level === null) {
    return isDisconnectedStatus(glasses) ? 'Not connected' : 'Waiting for status';
  }
  return `${level}%${glasses.connected && glasses.battery.charging ? ' charging' : ''}`;
}

export function wifiLabel(glasses: GlassesRuntimeState) {
  if (glasses.connected && glasses.wifi.state === 'connected') {
    return glasses.wifi.ssid;
  }
  if (glasses.connected && glasses.wifi.state === 'disconnected') {
    return 'Not connected';
  }
  return 'Unknown';
}

export function wifiSubLabel(glasses: GlassesRuntimeState) {
  if (glasses.connected && glasses.wifi.state === 'connected') {
    return glasses.wifi.localIp ?? 'connected';
  }
  return 'not connected';
}

export function hotspotLabel(glasses: GlassesRuntimeState, fallbackEnabled: boolean) {
  const hotspot = enabledHotspotStatus(glasses);
  if (hotspot) {
    return hotspot.localIp ? `${hotspot.ssid} · ${hotspot.localIp}` : hotspot.ssid;
  }
  if (!isHotspotEnabled(glasses, fallbackEnabled)) {
    return 'disabled';
  }
  return 'waiting for SSID';
}

const MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD = '00001111';

export function galleryServerUrl(glasses: GlassesRuntimeState, fallbackEnabled: boolean) {
  const hotspot = enabledHotspotStatus(glasses);
  if (hotspot) {
    return `http://${hotspot.localIp}:8089`;
  }
  if (!isHotspotEnabled(glasses, fallbackEnabled)) {
    return null;
  }
  return 'http://192.168.43.1:8089';
}

export function galleryHotspotSsidLabel(glasses: GlassesRuntimeState) {
  const hotspot = enabledHotspotStatus(glasses);
  return hotspot ? `Wi-Fi ${hotspot.ssid}` : 'the glasses hotspot';
}

export function galleryHotspotPasswordLabel(glasses: GlassesRuntimeState) {
  const hotspot = enabledHotspotStatus(glasses);
  return hotspot?.password || MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD;
}

export function firmwareLabel(glasses: GlassesRuntimeState) {
  return glasses.connected ? glasses.firmware.version ?? 'Unknown' : 'Unknown';
}

export function firmwareSubLabel(glasses: GlassesRuntimeState) {
  if (!glasses.connected || glasses.firmware.source === 'unknown') {
    return 'not reported';
  }
  if (glasses.firmware.source === 'app') {
    return `ASG app ${glasses.firmware.version}`;
  }
  return `${glasses.firmware.source} firmware`;
}

export function rssiLabel(glasses: GlassesRuntimeState) {
  const signal = glasses.connected ? glasses.signal.strengthDbm : null;
  return typeof signal === 'number' && signal !== -1 ? `${signal} dBm` : 'Unknown';
}

export function rssiUpdatedLabel(glasses: GlassesRuntimeState) {
  const updatedAt = glasses.connected ? glasses.signal.updatedAt : null;
  if (typeof updatedAt !== 'number' || updatedAt <= 0) {
    return 'signal';
  }
  return `updated ${eventTime.format(new Date(updatedAt))}`;
}

export function bluetoothSearchLabel(status: PhoneSdkRuntimeState, count: number) {
  return `${status.searching ? 'Scanning' : 'Idle'} · ${count} result${count === 1 ? '' : 's'}`;
}

export function discoveredLabel(devices: Device[]) {
  if (devices.length === 0) {
    return 'None yet';
  }
  return devices.map((device) => device.name).join(', ');
}

export function latestEventLabel(events: {text: string; time: string; tag: string}[]) {
  const latest = events[0];
  return latest ? latest.text : 'No events yet';
}

const eventTime = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function streamUptime(startedAt: number | null) {
  if (!startedAt) {
    return '00:00:00';
  }
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':');
}
