export type OtaFlowAdmission = 'done' | 'idle' | 'open' | 'wait_for_wifi';

export function otaFlowAdmission({
  completedConnectionKey,
  connectionKey,
  waitingForWifi,
  wifiConnected,
}: {
  completedConnectionKey: string | null;
  connectionKey: string | null;
  waitingForWifi: boolean;
  wifiConnected: boolean;
}): OtaFlowAdmission {
  if (!connectionKey) return 'idle';
  if (waitingForWifi) return wifiConnected ? 'open' : 'wait_for_wifi';
  return completedConnectionKey === connectionKey ? 'done' : 'open';
}
