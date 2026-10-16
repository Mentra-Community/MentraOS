/** The host offers only queued work. Accepted custody is never another delivery. */
export const hostRequestDeliveryFilter = (hostId: string) => ({hostId, state: 'queued'});
/** An acknowledgement accepts cooperative cancellation; it does not prove cleanup. */
export const hostCancellationDeliveryFilter = () => ({hostCancellation: {$exists: true}, cancellationAcknowledged: {$ne: true}});
/** Pending means waiting to start; custody and cancellation are separate. */
export const pendingRequestFilter = {
  state: {$in: ['awaiting-source', 'awaiting-runner', 'preparing', 'queued']},
  hostCancellation: {$exists: false}, fleetCancellation: {$exists: false}, preparationCancellation: {$exists: false},
  hostRejection: {$exists: false}, preparationRejection: {$exists: false}, terminalStatus: {$exists: false},
  dispatchCompletion: {$exists: false},
};
