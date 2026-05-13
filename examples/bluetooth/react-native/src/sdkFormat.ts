import type {CoreStatus, GlassesStatus, MentraDevice} from '@mentra/bluetooth-sdk';

export function connectionLabel(status: Partial<GlassesStatus>) {
  if (status.connectionState) {
    return status.connectionState;
  }
  return isGlassesConnected(status) ? 'CONNECTED' : 'WAITING';
}

export function isGlassesConnected(status: Partial<GlassesStatus>) {
  if (typeof status.connectionState === 'string') {
    const state = status.connectionState.toLowerCase();
    if (state === 'connected') {
      return true;
    }
    if (state === 'disconnected') {
      return false;
    }
  }
  return status.connected === true;
}

export function isGlassesWifiConnected(status: Partial<GlassesStatus>) {
  return status.wifiConnected === true;
}

export function isDisconnectedStatus(status: Partial<GlassesStatus>) {
  if (typeof status.connectionState === 'string') {
    const state = status.connectionState.toLowerCase();
    if (state === 'disconnected') {
      return true;
    }
    if (state === 'connected') {
      return false;
    }
  }
  return status.connected === false;
}

export function deviceLabel(status: Partial<GlassesStatus>) {
  return status.bluetoothName || status.serialNumber || status.deviceModel || 'Mentra Live';
}

export function supportsDisplay(status: Partial<GlassesStatus>) {
  const values = status as Record<string, unknown>;
  for (const key of ['supportsDisplay', 'hasDisplay', 'displaySupported', 'display']) {
    if (typeof values[key] === 'boolean') {
      return values[key] as boolean;
    }
  }
  for (const key of ['features', 'deviceFeatures', 'capabilities']) {
    const nested = values[key];
    if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).display === 'boolean') {
      return (nested as Record<string, boolean>).display;
    }
  }

  const model = [status.deviceModel, status.bluetoothName, values.defaultWearable]
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

export function modelLabel(status: Partial<GlassesStatus>) {
  return status.deviceModel || 'Mentra Live';
}

export function batteryLevel(status: Partial<GlassesStatus>) {
  if (
    !isGlassesConnected(status) ||
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
    return isDisconnectedStatus(status) ? 'Not connected' : 'Waiting for status';
  }
  return `${level}%${status.charging ? ' charging' : ''}`;
}

export function wifiLabel(status: Partial<GlassesStatus>) {
  if (status.wifiConnected) {
    return status.wifiSsid || 'Connected';
  }
  return isGlassesConnected(status) ? 'Disconnected' : 'Unknown';
}

export function wifiSubLabel(status: Partial<GlassesStatus>) {
  if (status.wifiConnected) {
    return status.wifiLocalIp || 'connected';
  }
  return 'not connected';
}

export function hotspotLabel(status: Partial<GlassesStatus>, fallbackEnabled: boolean) {
  const values = status as Record<string, unknown>;
  const enabled = typeof values.hotspotEnabled === 'boolean' ? values.hotspotEnabled : fallbackEnabled;
  if (!enabled) {
    return 'disabled';
  }
  const ssid = typeof values.hotspotSsid === 'string' ? values.hotspotSsid : '';
  if (!ssid) {
    return 'waiting for SSID';
  }
  const ip = typeof values.hotspotGatewayIp === 'string' ? values.hotspotGatewayIp : '';
  return ip ? `${ssid} · ${ip}` : ssid;
}

const MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD = '00001111';

export function galleryServerUrl(status: Partial<GlassesStatus>, fallbackEnabled: boolean) {
  const values = status as Record<string, unknown>;
  const enabled = typeof values.hotspotEnabled === 'boolean' ? values.hotspotEnabled : fallbackEnabled;
  if (!enabled) {
    return null;
  }
  const gateway = typeof values.hotspotGatewayIp === 'string' && values.hotspotGatewayIp
    ? values.hotspotGatewayIp
    : '192.168.43.1';
  return `http://${gateway}:8089`;
}

export function galleryHotspotSsidLabel(status: Partial<GlassesStatus>) {
  const values = status as Record<string, unknown>;
  const ssid = typeof values.hotspotSsid === 'string' && values.hotspotSsid
    ? values.hotspotSsid
    : '';
  return ssid ? `Wi-Fi ${ssid}` : 'the glasses hotspot';
}

export function galleryHotspotPasswordLabel(status: Partial<GlassesStatus>) {
  const values = status as Record<string, unknown>;
  return typeof values.hotspotPassword === 'string' && values.hotspotPassword
    ? values.hotspotPassword
    : MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD;
}

export function firmwareLabel(status: Partial<GlassesStatus>) {
  return (
    statusString(status, 'fwVersion') ||
    statusString(status, 'firmwareVersion') ||
    statusString(status, 'deviceFirmwareVersion') ||
    statusString(status, 'rightFirmwareVersion') ||
    statusString(status, 'leftFirmwareVersion') ||
    statusString(status, 'besFwVersion') ||
    statusString(status, 'mtkFwVersion') ||
    'Unknown'
  );
}

export function firmwareSubLabel(status: Partial<GlassesStatus>) {
  if (statusString(status, 'fwVersion') || statusString(status, 'firmwareVersion')) {
    return 'reported by glasses';
  }
  if (statusString(status, 'deviceFirmwareVersion')) {
    return 'device firmware';
  }
  if (statusString(status, 'rightFirmwareVersion')) {
    return 'right firmware';
  }
  if (statusString(status, 'leftFirmwareVersion')) {
    return 'left firmware';
  }
  if (statusString(status, 'besFwVersion')) {
    return 'BES firmware';
  }
  if (statusString(status, 'mtkFwVersion')) {
    return 'MTK firmware';
  }
  const appVersion = statusString(status, 'appVersion');
  if (appVersion) {
    return `ASG app ${appVersion}`;
  }
  return 'not reported';
}

function statusString(status: Partial<GlassesStatus>, key: string) {
  const value = (status as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function rssiLabel(status: Partial<GlassesStatus>) {
  const signal = statusNumber(status, 'signalStrength');
  return typeof signal === 'number' && signal !== -1 ? `${signal} dBm` : 'Unknown';
}

export function rssiUpdatedLabel(status: Partial<GlassesStatus>) {
  const updatedAt = statusNumber(status, 'signalStrengthUpdatedAt');
  if (typeof updatedAt !== 'number' || updatedAt <= 0) {
    return 'signal';
  }
  return `updated ${eventTime.format(new Date(updatedAt))}`;
}

function statusNumber(status: Partial<GlassesStatus>, key: string) {
  const value = (status as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

export function bluetoothSearchLabel(status: Partial<CoreStatus>) {
  const count = status.searchResults?.length ?? 0;
  return `${status.searching ? 'Scanning' : 'Idle'} · ${count} result${count === 1 ? '' : 's'}`;
}

export function discoveredLabel(devices: MentraDevice[]) {
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
