/** The host offers only queued work. Accepted custody is never another delivery. */
export const hostRequestDeliveryFilter = (hostId: string) => ({hostId, state: 'queued'});
/** An acknowledgement accepts cooperative cancellation; it does not prove cleanup. */
export const hostCancellationDeliveryFilter = () => ({hostCancellation: {$exists: true}, cancellationAcknowledged: {$ne: true}});
/** Waiting and active work excludes every durable cancellation fence. */
export const pendingRequestFilter = {
  state: {$ne: 'terminal'}, hostCancellation: {$exists: false}, fleetCancellation: {$exists: false},
  preparationCancellation: {$exists: false},
};
export const cancelledRequestFilter = {$or: [
  {hostCancellation: {$exists: true}}, {fleetCancellation: {$exists: true}}, {preparationCancellation: {$exists: true}},
]};
export interface RequestActivityRecord {
  state: string;
  hostCancellation?: unknown;
  fleetCancellation?: unknown;
  preparationCancellation?: unknown;
  cancellationAcknowledged?: boolean | null;
}
export function requestActivity(row: RequestActivityRecord) {
  if (row.hostCancellation !== undefined || row.fleetCancellation !== undefined || row.preparationCancellation !== undefined)
    return 'cancellation' as const;
  if (row.state === 'terminal') return 'terminal' as const;
  return ['awaiting-source', 'awaiting-runner', 'preparing', 'queued'].includes(row.state) ? 'waiting' as const
    : ['accepted', 'running'].includes(row.state) ? 'active' as const : 'unknown' as const;
}
