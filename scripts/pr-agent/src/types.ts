import { z } from 'zod';

export const ReviewSlotSchema = z.enum(['bugbot', 'standards', 'depth', 'codex']);
export type ReviewSlot = z.infer<typeof ReviewSlotSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  source: z.string(),
  severity: z.enum(['blocking', 'nit']),
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
  status: z.enum(['open', 'resolved']),
  introducedCycle: z.number(),
  lastSeenCycle: z.number(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const PrAgentStateSchema = z.object({
  cycle: z.number().default(0),
  fixRound: z.number().default(0),
  totalReviewerRuns: z.number().default(0),
  consecutiveNoNewReviews: z.number().default(0),
  openFindings: z.array(FindingSchema).default([]),
  resolvedFindings: z.array(FindingSchema).default([]),
  nitFindings: z.array(FindingSchema).default([]),
  frozenPair: z.array(ReviewSlotSchema).optional(),
  phase: z.enum(['discovery', 'convergence']).default('discovery'),
  status: z
    .enum(['in_progress', 'human_handoff', 'budget_exhausted', 'diverging'])
    .default('in_progress'),
  lastPair: z.array(ReviewSlotSchema).optional(),
  stagnationFixRounds: z.number().default(0),
  lastOpenCount: z.number().optional(),
  fingerprintReopenCounts: z.record(z.number()).default({}),
  /** Fingerprints a human marked as false positive via `agent-resolve <id>`. */
  mutedFingerprints: z.array(z.string()).default([]),
  /**
   * Orchestrator-initiated `workflow_dispatch` continuations spent on this PR.
   * Only consumed when no CI gate matches the diff, so no `workflow_run` event
   * will ever arrive to drive the next cycle. Reset on each `pull_request`
   * event (new push means the human moved the PR forward).
   */
  selfDispatches: z.number().default(0),
  /**
   * Monotonic counter bumped on every successful state comment write.
   * Used by saveState to refuse lost-update overwrites from stale concurrent runs.
   */
  revision: z.number().default(0),
});

export type PrAgentState = z.infer<typeof PrAgentStateSchema>;

export const VerdictSchema = z.object({
  verdict: z.enum(['approve', 'changes_requested']),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocking', 'nit']),
        file: z.string(),
        line: z.number().optional(),
        message: z.string(),
        /**
         * Id of an existing open finding the reviewer is re-confirming. The
         * report then inherits that finding's fingerprint so rewording the
         * same issue cannot fork it into a duplicate identity.
         */
        ref: z.string().optional(),
      }),
    )
    .default([]),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export const MARKER_ORCHESTRATOR = '<!-- pr-agent-orchestrator -->';
export const MARKER_HANDOFF = '<!-- pr-agent-handoff -->';
export const MARKER_BUGBOT_VERDICT = '<!-- pr-agent-bugbot-verdict -->';
export const MARKER_REVIEW = '<!-- pr-agent-review -->';

export type PlanOutput = {
  runBugbot: boolean;
  runStandards: boolean;
  runDepth: boolean;
  activePair: ReviewSlot[];
  state: PrAgentState;
  shouldSkip: boolean;
  skipReason?: string;
  shouldHandoff?: boolean;
  handoffReason?: 'human_handoff' | 'budget_exhausted' | 'diverging';
  recheckOnly?: boolean;
};

export type AggregateOutput = {
  state: PrAgentState;
  shouldFix: boolean;
  shouldHandoff: boolean;
  handoffReason?: 'human_handoff' | 'budget_exhausted' | 'diverging';
  ciFailed: boolean;
  newBlockingCount: number;
  /**
   * Blocking findings first introduced this cycle by model reviewers (external
   * bot findings excluded — those already exist as inline comments). Used to
   * post inline PR review comments anchored at file/line.
   */
  newBlockingFindings: Finding[];
  /**
   * True when reviewers were scheduled but none produced a usable verdict.
   * The cycle carried no review signal, so no convergence counters moved.
   */
  emptyCycle?: boolean;
  /**
   * The cycle ended cleanly but short of handoff, and nothing external will
   * start the next one: no CI gate matches the diff (so no `workflow_run`
   * completion is coming) and no fixer push is queued. The workflow
   * self-dispatches to keep converging instead of stranding the PR.
   */
  needsContinuation?: boolean;
};
