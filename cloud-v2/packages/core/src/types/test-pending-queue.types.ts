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
  diagnosis?: {
    stage: string;
    nextAction: string;
    conditions: {label: string; status: 'passed' | 'waiting' | 'unknown' | 'failed'; expected: string; observed: string;
      hostId?: string; laneId?: string; resourceId?: string; owner?: string}[];
  };
  build?: {headSha: string; prNumber?: number; channel: string};
  assignment?: {hostId: string; laneId: string};
  compatibilityKnown: boolean;
  compatibleLanes: PendingQueueLane[];
  platformCandidates: PendingQueueLane[];
}
export interface PendingQueuePage {
  items: PendingQueueItem[];
  total: number;
  nextCursor?: string;
  observedAt: string;
}
