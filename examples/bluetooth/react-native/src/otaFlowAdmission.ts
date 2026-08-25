export type OtaFlowAdmission = 'done' | 'idle' | 'open' | 'wait_for_wifi';

export function otaFlowAdmission({
  completedConnectionGeneration,
  connectionGeneration,
  waitingForWifi,
  wifiConnected,
}: {
  completedConnectionGeneration: number | null;
  connectionGeneration: number | null;
  waitingForWifi: boolean;
  wifiConnected: boolean;
}): OtaFlowAdmission {
  if (connectionGeneration === null) return 'idle';
  if (waitingForWifi) return wifiConnected ? 'open' : 'wait_for_wifi';
  return completedConnectionGeneration === connectionGeneration ? 'done' : 'open';
}
