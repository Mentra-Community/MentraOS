export type OtaFlowAdmission = 'done' | 'idle' | 'open' | 'wait_for_wifi';

export function otaFlowAdmission({
  completedConnectionGeneration,
  connectionGeneration,
  waitingForWifi,
}: {
  completedConnectionGeneration: number | null;
  connectionGeneration: number | null;
  waitingForWifi: boolean;
}): OtaFlowAdmission {
  // Setup is a user-controlled detour: an existing connection (or a reconnect)
  // must not dismiss it before the user has finished changing networks.
  if (waitingForWifi) return 'wait_for_wifi';
  if (connectionGeneration === null) return 'idle';
  return completedConnectionGeneration === connectionGeneration ? 'done' : 'open';
}
