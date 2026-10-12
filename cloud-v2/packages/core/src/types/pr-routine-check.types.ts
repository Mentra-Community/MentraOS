import type {PortableRoutineSelection} from './routine-job.types'
import type {RoutineProgress} from './routine-progress.types'

export const ROUTINE_CHECK_NAME = 'Routine tests'
export const ROUTINE_CHECK_REPOSITORY = 'Mentra-Community/MentraOS'
export type CheckConclusion = 'success' | 'failure' | 'cancelled' | 'timed_out'
export type PrRoutineContext = {
  number: number; headSha: string; baseRef: string; headRef: string; sameRepository: boolean;
  open: boolean; labels: string[]; peers: number[]
}
export type PrRoutineMember = {
  memberId: string; routineId: string; platform: 'android' | 'ios-on-mac';
  title: string; stepIds: string[]; stepNames: string[];
  originalRequestId?: string; requestId?: string; selection?: PortableRoutineSelection;
  status: string; publicationComplete: boolean; settled: boolean; progress?: RoutineProgress;
  laneLabel?: string; waitReason?: string; containmentPending?: boolean;
}
export type PrRoutineAttempt = {
  generation: number; acceptedAt: string; deadline: string; members: PrRoutineMember[];
  suiteId?: string; suiteStartedAt?: string; rerun?: {id: string; previewDigest?: string; memberIds: string[]; linkedMemberIds?: string[]};
  conclusion?: CheckConclusion; finishedAt?: string;
  cancellation?: {kind: 'cancel' | 'superseded' | 'closed' | 'timeout'; requestedAt: string}
}
export type PrRoutineCheck = {
  gateId: string; headSha: string; context: PrRoutineContext; selectionKey: string;
  coverageGeneration: number; routineRevision?: string; attempt: PrRoutineAttempt;
  selectionComplete?: boolean;
  retired: PrRoutineAttempt[]; controls: Array<{id: string; kind: 'rerun' | 'cancel'; generation: number; actor: string}>;
  checkId?: number; checkExternalId: string; createAttempted?: boolean;
  selectionError?: string;
  buildRequests?: Partial<Record<'android' | 'ios-on-mac', {state: 'intended' | 'answered'; requestedAt: string}>>;
  predecessors?: string[];
  reporting: {nextAt: string; intended?: {revision: number; payload: CheckPayload; digest: string};
    deliveredDigest?: string; deliveredAt?: string; error?: string}
}
export type CheckPayload = {
  name: typeof ROUTINE_CHECK_NAME; head_sha: string; external_id: string;
  status: 'queued' | 'in_progress' | 'completed'; conclusion?: CheckConclusion;
  started_at: string; completed_at?: string; details_url: string;
  output: {title: string; summary: string};
  actions?: Array<{label: string; description: string; identifier: 'cancel'}>
}
export type PrRoutineCheckRow = {gateId: string; revision: number; payload: PrRoutineCheck; nextAt: Date;
  lease?: {id: string; expiresAt: Date}}
