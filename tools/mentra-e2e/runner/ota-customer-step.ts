import type {
  AssertionObservation,
  Json,
  LifecycleContext,
  MutationIntent,
  MutationStep,
  Observation,
  Reconciliation,
} from "./lifecycle"
import {
  runOtaCustomerSequence,
  type OtaCustomerActions,
  type OtaCustomerProgress,
  type OtaCustomerSelection,
} from "./ota-customer-sequence"

export interface OtaCustomerStepRuntime {
  /** Fresh, independently verified prepared baseline before the first dispatch. */
  prepare(context: LifecycleContext): Promise<AssertionObservation>
  /** Reuse the caller's Report/actions. The caller owns recording/logger cleanup. */
  recording(
    context: LifecycleContext,
    intent: Readonly<MutationIntent>,
  ): Promise<{
    selection: OtaCustomerSelection
    actions: OtaCustomerActions
    metadata: Record<string, unknown>
  }>
  /** Direct read-only updater/stream/identity proof. Only settled means idle;
   * active/unknown retain ownership and prohibit restoration. Never return satisfied. */
  idle(context: LifecycleContext, intent: Readonly<MutationIntent>): Promise<Reconciliation>
  /** Independent current target/paired-home proof, not a copied Report verdict. */
  verifyTarget(context: LifecycleContext, intent: Readonly<MutationIntent>): Promise<AssertionObservation>
  recordFailure?(
    error: unknown,
    context: LifecycleContext,
    intent: Readonly<MutationIntent>,
    progress: Readonly<OtaCustomerProgress>,
  ): Promise<void>
  clock?: Parameters<typeof runOtaCustomerSequence>[4]
}

type Dispatch = {
  kind: "ota-customer-sequence/v1"
  operationID: string
  progress: OtaCustomerProgress
  failed: boolean
  error: string | null
  reportingError: string | null
}
const id = "customer-sequence"
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function fresh<T extends Observation>(read: () => Promise<T>): Promise<T> {
  const started = Date.now()
  const value = await read()
  const at = Date.parse(value?.observedAt)
  if (
    !Number.isFinite(at) ||
    at < started - 1000 ||
    at > Date.now() + 1000 ||
    !value.source?.trim() ||
    !Array.isArray(value.evidence) ||
    !value.evidence.length ||
    value.evidence.some((path) => typeof path !== "string" || !path.trim()) ||
    value.expected === undefined ||
    value.actual === undefined
  )
    throw new Error("Customer step requires a fresh independent observation with evidence")
  return value
}

function owned(context: LifecycleContext, intent?: Readonly<MutationIntent>) {
  const matches = context.operations.filter((operation) => operation.stepID === id)
  if (
    matches.length > 1 ||
    (intent ? matches.length !== 1 : matches.length !== 0) ||
    (intent &&
      (intent.stepID !== id ||
        intent.phase !== "test" ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(intent.operationID) ||
        matches[0].operationID !== intent.operationID ||
        matches[0].phase !== "test"))
  )
    throw new Error("Customer step requires its original test-phase lifecycle intent")
}

function dispatch(intent: Readonly<MutationIntent>): Dispatch | undefined {
  if (intent.dispatch === undefined) return undefined // Process ended before dispatch metadata was durable.
  const value = intent.dispatch as unknown as Dispatch
  if (
    !value ||
    value.kind !== "ota-customer-sequence/v1" ||
    value.operationID !== intent.operationID ||
    typeof value.failed !== "boolean" ||
    typeof value.progress?.finished !== "boolean" ||
    typeof value.progress.started !== "boolean" ||
    !Number.isInteger(value.progress.installPasses) ||
    value.progress.installPasses < 0 ||
    value.progress.installPasses > 8 ||
    (value.error !== null && typeof value.error !== "string") ||
    (value.reportingError !== null && typeof value.reportingError !== "string")
  )
    throw new Error("Customer dispatch metadata is missing or belongs to another operation")
  return value
}

/** One customer mutation under runLifecycle's existing lease/journal. Recovery
 * never opens recording actions or replays the customer loop. A settled failure
 * permits teardown but does not satisfy this test; runLifecycle freezes failure
 * before restoring, including after process restart. No fixture state is written here. */
export function createOtaCustomerStep(runtime: OtaCustomerStepRuntime): MutationStep {
  return {
    id,
    kind: "mutation",
    repeat: "never",
    instruction: "Run the recorded customer OTA sequence once and preserve its outcome before restoration.",
    async execute(context, intent) {
      owned(context, intent)
      if (intent.dispatch !== undefined || intent.dispatchError !== undefined)
        throw new Error("Customer operation was already dispatched; it cannot be replayed")
      const progress: OtaCustomerProgress = {started: false, installPasses: 0, finished: false}
      const result: Dispatch = {
        kind: "ota-customer-sequence/v1",
        operationID: intent.operationID,
        progress,
        failed: false,
        error: null,
        reportingError: null,
      }
      try {
        const recording = await runtime.recording(context, intent)
        if (recording.selection.resume) throw new Error("A new customer lifecycle cannot adopt a prior UI sequence")
        await runOtaCustomerSequence(
          structuredClone(recording.selection),
          progress,
          recording.metadata,
          recording.actions,
          runtime.clock,
        )
      } catch (error) {
        result.failed = true
        result.error = errorText(error)
        try {
          await runtime.recordFailure?.(error, context, intent, structuredClone(progress))
        } catch (reportingError) {
          result.reportingError = errorText(reportingError)
        }
      }
      // runLifecycle appends this before reconciliation. No in-memory flag is
      // needed to remember the original failure in another process.
      return result as unknown as Json
    },
    async reconcile(context, intent) {
      owned(context, intent)
      if (!intent) {
        const prepared = await fresh(() => runtime.prepare(context))
        if (typeof prepared.passed !== "boolean") throw new Error("Prepared baseline omitted its verdict")
        return {...prepared, status: prepared.passed ? "settled" : "unknown"}
      }
      const saved = dispatch(intent)
      let target: AssertionObservation | undefined
      let targetError: string | null = null
      if (
        saved?.progress.finished &&
        !saved.failed &&
        saved.error === null &&
        saved.reportingError === null &&
        !intent.dispatchError
      ) {
        try {
          target = await fresh(() => runtime.verifyTarget(context, intent))
          if (typeof target.passed !== "boolean") throw new Error("Target observation omitted its verdict")
        } catch (error) {
          target = undefined
          targetError = errorText(error)
        }
      }
      // Close target reads with fresh idle evidence. Versions matching alone do
      // not establish that a writer or pending restart has finished.
      const idle = await fresh(() => runtime.idle(context, intent))
      if (!["settled", "active", "unknown"].includes(idle.status))
        throw new Error("Customer idle proof must independently report settled, active or unknown")
      const satisfied = idle.status === "settled" && target?.passed === true
      return {
        ...idle,
        status: satisfied ? "satisfied" : idle.status,
        expected: "Finished customer sequence, current target and independent idle proof",
        actual: {
          dispatch: (saved as unknown as Json) ?? null,
          dispatchError: intent.dispatchError ?? null,
          idle: idle.actual,
          target: target?.actual ?? null,
          targetError,
        },
        evidence: [...idle.evidence, ...(target?.evidence ?? [])],
      }
    },
  }
}
