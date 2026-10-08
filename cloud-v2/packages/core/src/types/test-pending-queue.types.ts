export interface PendingQueueLane {
  hostId: string;
  laneId: string;
  platform: 'android' | 'ios-on-mac';
  glassesModels: string[];
  state: string;
  dispatchMode: string;
  fresh: boolean;
}
export interface PendingQueueItem {
  requestId: string;
  routineId?: string;
  platform?: 'android' | 'ios-on-mac';
  state: string;
  createdAt?: string;
  reason?: string;
  build?: {headSha: string; prNumber?: number; channel: string};
  assignment?: {hostId: string; laneId: string};
  compatibilityKnown: boolean;
  compatibleLanes: PendingQueueLane[];
  platformCandidates: PendingQueueLane[];
  cancellation?: {acknowledged: boolean; cleanupPending: boolean; custody: Array<{hostId: string; laneId: string; ownerId: string; ownerKind: string}>};
}
export interface PendingQueuePage {
  items: PendingQueueItem[];
  total: number;
  nextCursor?: string;
  observedAt: string;
  cancellations: PendingQueueItem[];
  cancellationsTruncated: boolean;
}
