import type {CoreStatus, DeviceSearchResult, GlassesStatus} from '@mentra/bluetooth-sdk';

export function connectionLabel(status: Partial<GlassesStatus>) {
  if (status.connectionState) {
    return status.connectionState;
  }
  if (typeof status.connected === 'boolean') {
    return status.connected ? 'CONNECTED' : 'DISCONNECTED';
  }
  return 'WAITING';
}

export function deviceLabel(status: Partial<GlassesStatus>) {
  return status.bluetoothName || status.serialNumber || status.deviceModel || 'Mentra Live';
}

export function modelLabel(status: Partial<GlassesStatus>) {
  return status.deviceModel || 'Mentra Live';
}

export function batteryLevel(status: Partial<GlassesStatus>) {
  if (
    status.connected === false ||
    typeof status.batteryLevel !== 'number' ||
    status.batteryLevel < 0
  ) {
    return null;
  }
  return Math.min(status.batteryLevel, 100);
}

export function batteryLabel(status: Partial<GlassesStatus>) {
  const level = batteryLevel(status);
  if (level === null) {
    return status.connected === false ? 'Not connected' : 'Waiting for status';
  }
  return `${level}%${status.charging ? ' charging' : ''}`;
}

export function wifiLabel(status: Partial<GlassesStatus>) {
  if (status.wifiConnected) {
    return status.wifiSsid || 'Connected';
  }
  return status.connected ? 'Disconnected' : 'Unknown';
}

export function wifiSubLabel(status: Partial<GlassesStatus>) {
  if (status.wifiConnected) {
    return status.wifiLocalIp || 'connected';
  }
  return 'not connected';
}

export function firmwareLabel(status: Partial<GlassesStatus>) {
  return status.appVersion || status.fwVersion || status.mtkFwVersion || status.besFwVersion || 'Unknown';
}

export function rssiLabel(status: Partial<GlassesStatus>) {
  return typeof status.signalStrength === 'number' ? `${status.signalStrength} dBm` : 'Unknown';
}

export function rssiQuality(status: Partial<GlassesStatus>) {
  if (typeof status.signalStrength !== 'number') {
    return 'unknown';
  }
  return status.signalStrength > -65 ? 'strong' : status.signalStrength > -80 ? 'fair' : 'weak';
}

export function bluetoothSearchLabel(status: Partial<CoreStatus>) {
  const count = status.searchResults?.length ?? 0;
  return `${status.searching ? 'Scanning' : 'Idle'} · ${count} result${count === 1 ? '' : 's'}`;
}

export function discoveredLabel(devices: DeviceSearchResult[]) {
  if (devices.length === 0) {
    return 'None yet';
  }
  return devices.map((device) => device.deviceName).join(', ');
}

export function latestEventLabel(events: {text: string; time: string; tag: string}[]) {
  const latest = events[0];
  return latest ? latest.text : 'No events yet';
}

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
