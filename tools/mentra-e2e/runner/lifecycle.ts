import {randomUUID} from "node:crypto"
import {mkdir, open, readFile, rename, rm} from "node:fs/promises"
import {dirname, join, resolve} from "node:path"
import {isDeepStrictEqual} from "node:util"

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json}
export type LifecyclePhase =
  | "preflight"
  | "setup"
  | "test"
  | "final-assertions"
  | "teardown"
  | "return-verification"
  | "evidence"
export type PhaseVerdict = "not-run" | "passed" | "failed" | "cancelled" | "deferred"
export type TestVerdict = "not-run" | "passed" | "failed" | "cancelled"

/** These inputs must already be resolved, verified and redacted by the caller. */
export interface LifecycleSelection {
  runID: string
  fixtureID: string
  returnProfileDigest: string
  inputs: Json
}

export interface Observation {
  expected: Json
  actual: Json
  observedAt: string
  source: string
  evidence: string[]
  identity?: Json
}

export interface AssertionObservation extends Observation {
  passed: boolean
}

/** Only settled/satisfied permit a subsequent mutation. No timeout cancels a writer. */
export interface Reconciliation extends Observation {
  status: "satisfied" | "settled" | "active" | "unknown"
}

export interface MutationIntent {
  operationID: string
  stepID: string
  phase: LifecyclePhase
  startedAt: string
  dispatch?: Json
  dispatchError?: string
  reconciliation?: Reconciliation
}

export interface LifecycleContext {
  runDirectory: string
  selection: Readonly<LifecycleSelection>
  /** Includes partial setup and failed dispatches so cleanup does not assume setup finished. */
  operations: readonly MutationIntent[]
}

interface StepDescription {
  id: string
  instruction: string
}

export interface AssertionStep extends StepDescription {
  kind: "assertion"
  observe(context: LifecycleContext): Promise<AssertionObservation>
}

export interface MutationStep extends StepDescription {
  kind: "mutation"
  /** Automatic resend is deliberately unsupported, including during recovery. */
  repeat: "never"
  execute(context: LifecycleContext, intent: Readonly<MutationIntent>): Promise<Json | void>
  /** No intent means a fresh precondition/postcondition probe before any dispatch. */
  reconcile(context: LifecycleContext, intent?: Readonly<MutationIntent>): Promise<Reconciliation>
}

export type LifecycleStep = AssertionStep | MutationStep

export interface LifecycleRoutine {
  id: string
  definitionDigest: string
  preflight: AssertionStep[]
  setup: LifecycleStep[]
  test: LifecycleStep[]
  finalAssertions: AssertionStep[]
  teardown: LifecycleStep[]
  returnVerification: AssertionStep[]
  /** Verify required recordings/assertion artifacts; uploading is a separate concern. */
  evidence: AssertionStep[]
}

export interface LifecycleState {
  schemaVersion: 1
  runID: string
  phase: LifecyclePhase
  mode: "running" | "recovering" | "complete"
  phases: Record<LifecyclePhase, PhaseVerdict>
  testStarted: boolean
  testFrozen: boolean
  test: TestVerdict
  operations: MutationIntent[]
  activeOperationID?: string
  pendingReconciliation?: {phase: LifecyclePhase; stepID: string}
}

export interface LifecycleEvent {
  sequence: number
  timestamp: string
  monotonicMs: number
  phase: LifecyclePhase
  type: string
  stepID?: string
  details: Json
  /** The journal is authoritative; state.json is an atomically replaced convenience checkpoint. */
  state: LifecycleState
}

export interface FixtureRecord {
  schemaVersion: 1
  fixtureID: string
  status: "ready" | "busy" | "recovery-required"
  runID: string
  runDirectory: string
  returnProfileDigest: string
  lastVerification?: {runDirectory: string; sequence: number}
}

export interface LifecycleResult {
  schemaVersion: 1
  runID: string
  test: TestVerdict
  teardown: PhaseVerdict
  returnVerification: PhaseVerdict
  evidence: PhaseVerdict
  fixture: "ready" | "recovery-required"
  outcome: "passed" | "failed" | "setup-failed" | "cancelled" | "incomplete"
}

export interface LifecycleOptions {
  runDirectory: string
  fixtureDirectory: string
  selection: LifecycleSelection
  routine: LifecycleRoutine
  /** Mandatory exclusive ownership of all resources; acquire before any fixture read. */
  acquireLease(): Promise<() => Promise<void>>
  /** Stops new test/setup steps. Cleanup is still attempted without forwarding an aborted signal. */
  signal?: AbortSignal
  /** An explicit operator stop can also prohibit new cleanup mutations. Reads remain allowed. */
  mutationsAllowed?: () => boolean
}

const phases: LifecyclePhase[] = [
  "preflight",
  "setup",
  "test",
  "final-assertions",
  "teardown",
  "return-verification",
  "evidence",
]

class Cancelled extends Error {}
class Deferred extends Error {}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function jsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await rm(temporary, {force: true})
  }
}

function definition(routine: LifecycleRoutine): Record<LifecyclePhase, LifecycleStep[]> {
  const steps = {
    "preflight": routine.preflight,
    "setup": routine.setup,
    "test": routine.test,
    "final-assertions": routine.finalAssertions,
    "teardown": routine.teardown,
    "return-verification": routine.returnVerification,
    "evidence": routine.evidence,
  }
  const ids = new Set<string>()
  if (!routine.id || !routine.definitionDigest) throw new Error("A frozen routine identity and digest are required")
  for (const phase of phases) {
    if (!Array.isArray(steps[phase])) throw new Error(`Missing ${phase} steps`)
    if (["preflight", "final-assertions", "return-verification", "evidence"].includes(phase) && !steps[phase].length)
      throw new Error(`${phase} requires independent assertions`)
    for (const step of steps[phase]) {
      if (!step.id || !step.instruction || ids.has(step.id)) throw new Error("Step IDs must be nonempty and unique")
      ids.add(step.id)
      if (step.kind !== "assertion" && step.kind !== "mutation") throw new Error("Unknown lifecycle step kind")
      if (step.kind === "mutation") {
        if (!["setup", "test", "teardown"].includes(phase) || step.repeat !== "never")
          throw new Error("Mutations are allowed only in setup, test and teardown, with no automatic resend")
      }
    }
  }
  return steps
}

function checkObservation(observation: Observation, started: number) {
  const timestamp = Date.parse(observation?.observedAt)
  // Allow second-resolution device observations, but never reuse older phase/run evidence.
  if (
    !observation ||
    !Number.isFinite(timestamp) ||
    timestamp < started - 1000 ||
    timestamp > Date.now() + 1000 ||
    !observation.source?.trim() ||
    !Array.isArray(observation.evidence) ||
    !observation.evidence.length ||
    observation.evidence.some((reference) => typeof reference !== "string" || !reference.trim()) ||
    observation.expected === undefined ||
    observation.actual === undefined
  )
    throw new Error("Missing, stale or malformed observation; this cannot establish a postcondition")
}

function validFixture(record: FixtureRecord, fixtureID: string) {
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.fixtureID !== fixtureID ||
    !["ready", "busy", "recovery-required"].includes(record.status) ||
    !record.runID ||
    !record.runDirectory ||
    !record.returnProfileDigest
  )
    throw new Error("Invalid fixture ownership record; manual reconciliation is required")
}

class Journal {
  sequence = 0
  private failed = false
  constructor(
    readonly directory: string,
    public state: LifecycleState,
  ) {}

  async append(type: string, details: Json = {}, stepID?: string) {
    if (this.failed) throw new Error("Journal persistence failed; no further actions are permitted")
    const event: LifecycleEvent = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      monotonicMs: performance.now(),
      phase: this.state.phase,
      type,
      stepID,
      details,
      state: this.state,
    }
    try {
      const handle = await open(join(this.directory, "events.jsonl"), "a", 0o600)
      try {
        await handle.writeFile(JSON.stringify(event) + "\n")
        await handle.sync()
      } finally {
        await handle.close()
      }
      // If this fails, the caller must stop; a durable intent may already be in the journal.
      await atomicJson(join(this.directory, "state.json"), this.state)
    } catch (error) {
      this.failed = true
      throw error
    }
  }

  static async resume(directory: string, runID: string) {
    const lines = (await readFile(join(directory, "events.jsonl"), "utf8")).split("\n")
    if (lines.pop() !== "" || !lines.length) throw new Error("Incomplete journal; do not replay or resend mutations")
    let last: LifecycleEvent | undefined
    for (const line of lines) {
      const event = JSON.parse(line) as LifecycleEvent
      if (
        event.sequence !== (last?.sequence ?? 0) + 1 ||
        event.state?.schemaVersion !== 1 ||
        event.state.runID !== runID ||
        !phases.includes(event.phase)
      )
        throw new Error("Invalid journal ordering or ownership; do not replay mutations")
      last = event
    }
    const journal = new Journal(directory, last!.state)
    journal.sequence = last!.sequence
    return journal
  }
}

class Execution {
  readonly steps: Record<LifecyclePhase, LifecycleStep[]>
  constructor(
    readonly options: LifecycleOptions,
    readonly journal: Journal,
  ) {
    this.steps = definition(options.routine)
  }

  context(): LifecycleContext {
    return structuredClone({
      runDirectory: resolve(this.options.runDirectory),
      selection: this.options.selection,
      operations: this.journal.state.operations,
    })
  }

  async reconcile(step: MutationStep, intent?: MutationIntent) {
    this.journal.state.pendingReconciliation = {phase: this.journal.state.phase, stepID: step.id}
    await this.journal.append("reconciliation-started", {operationID: intent?.operationID ?? null}, step.id)
    const started = Date.now()
    const result = await step.reconcile(this.context(), intent && structuredClone(intent))
    checkObservation(result, started)
    if (!["satisfied", "settled", "active", "unknown"].includes(result.status))
      throw new Error("Invalid mutation reconciliation status")
    if (result.status === "satisfied" || result.status === "settled") {
      delete this.journal.state.pendingReconciliation
      if (intent) delete this.journal.state.activeOperationID
    }
    if (intent) {
      intent.reconciliation = result
    }
    await this.journal.append("reconciliation", result as unknown as Json, step.id)
    return result
  }

  async step(step: LifecycleStep, honorCancellation: boolean) {
    if (honorCancellation && this.options.signal?.aborted) throw new Cancelled("Routine cancelled before next step")
    await this.journal.append("step-started", {instruction: step.instruction}, step.id)
    if (step.kind === "assertion") {
      const started = Date.now()
      const observation = await step.observe(this.context())
      checkObservation(observation, started)
      if (typeof observation.passed !== "boolean") throw new Error("Assertion omitted its verdict")
      await this.journal.append("assertion", observation as unknown as Json, step.id)
      if (!observation.passed) throw new Error(`Assertion failed: ${step.id}`)
      return
    }
    const previous = this.journal.state.operations.find((operation) => operation.stepID === step.id)
    const before = await this.reconcile(step, previous)
    if (before.status === "satisfied") return
    if (before.status !== "settled") throw new Deferred(`Cannot safely start ${step.id}: ${before.status}`)
    if (previous)
      throw new Deferred(`Operation ${previous.operationID} did not satisfy ${step.id}; no automatic resend`)
    if (this.options.mutationsAllowed?.() === false) throw new Deferred("Operator stopped new mutations")
    if (honorCancellation && this.options.signal?.aborted) throw new Cancelled("Routine cancelled before mutation")

    const intent: MutationIntent = {
      operationID: randomUUID(),
      stepID: step.id,
      phase: this.journal.state.phase,
      startedAt: new Date().toISOString(),
    }
    this.journal.state.operations.push(intent)
    this.journal.state.activeOperationID = intent.operationID
    await this.journal.append("mutation-intent", intent as unknown as Json, step.id)
    try {
      // Deliberately no timeout/abort race: losing patience must not kill a firmware writer.
      intent.dispatch = (await step.execute(this.context(), structuredClone(intent))) ?? null
    } catch (error) {
      intent.dispatchError = errorText(error)
    }
    await this.journal.append("mutation-dispatched", intent as unknown as Json, step.id)
    const after = await this.reconcile(step, intent)
    if (after.status !== "satisfied")
      throw new Error(`Mutation ${step.id} did not satisfy its postcondition: ${after.status}`)
  }

  async phase(phase: LifecyclePhase, honorCancellation = false) {
    const state = this.journal.state
    state.phase = phase
    if (phase === "test") state.testStarted = true
    await this.journal.append("phase-started")
    try {
      for (const step of this.steps[phase]) await this.step(step, honorCancellation)
      if (honorCancellation && this.options.signal?.aborted) throw new Cancelled("Routine cancelled during the phase")
      state.phases[phase] = "passed"
      await this.journal.append("phase-finished", {verdict: "passed"})
    } catch (error) {
      state.phases[phase] = error instanceof Cancelled ? "cancelled" : error instanceof Deferred ? "deferred" : "failed"
      await this.journal.append("phase-finished", {verdict: state.phases[phase], error: errorText(error)})
      throw error
    }
  }

  async freezeTest(verdict: TestVerdict, reason?: string) {
    if (this.journal.state.testFrozen) return
    this.journal.state.test = verdict
    this.journal.state.testFrozen = true
    await this.journal.append("test-frozen", {verdict, reason: reason ?? "Main phases finished"})
  }

  async recoverPending() {
    const state = this.journal.state
    if (!state.activeOperationID && !state.pendingReconciliation) return
    const intent = state.operations.find((operation) => operation.operationID === state.activeOperationID)
    const pending = intent ?? state.pendingReconciliation!
    const step = this.steps[pending.phase]?.find((step) => step.id === pending.stepID)
    if (!step || step.kind !== "mutation") throw new Error("Pending operation has no matching frozen routine step")
    state.phase = pending.phase
    await this.reconcile(step, intent)
  }

  async finish(): Promise<LifecycleResult> {
    const state = this.journal.state
    const unsettled = () => !!(state.activeOperationID || state.pendingReconciliation)
    if (unsettled()) {
      state.phases.teardown = "deferred"
      state.phases["return-verification"] = "deferred"
      await this.journal.append("recovery-required", {reason: "An operation remains active or its outcome is unknown"})
    } else {
      if (state.phases.preflight !== "passed" && !state.operations.length) {
        // Wrong identity/artifacts/permissions must not accidentally authorize a restore write.
        state.phase = "teardown"
        state.phases.teardown = "passed"
        await this.journal.append("teardown-not-needed", {reason: "Preflight did not authorize any mutation"})
      } else await this.phase("teardown").catch(() => {})
      // Teardown may have started an operation whose outcome could not be established.
      if (!unsettled()) await this.phase("return-verification").catch(() => {})
      else state.phases["return-verification"] = "deferred"
    }
    await this.phase("evidence").catch(() => {})
    const ready = state.phases.teardown === "passed" && state.phases["return-verification"] === "passed" && !unsettled()
    const outcome = !ready
      ? "failed"
      : state.test === "cancelled"
        ? "cancelled"
        : state.test === "not-run"
          ? "setup-failed"
          : state.test === "failed"
            ? "failed"
            : state.phases.evidence !== "passed"
              ? "incomplete"
              : "passed"
    const result: LifecycleResult = {
      schemaVersion: 1,
      runID: state.runID,
      test: state.test,
      teardown: state.phases.teardown,
      returnVerification: state.phases["return-verification"],
      evidence: state.phases.evidence,
      fixture: ready ? "ready" : "recovery-required",
      outcome,
    }
    state.mode = "complete"
    await this.journal.append("run-finished", result as unknown as Json)
    await atomicJson(join(this.options.runDirectory, "result.json"), result)
    const fixture: FixtureRecord = {
      schemaVersion: 1,
      fixtureID: this.options.selection.fixtureID,
      status: result.fixture,
      runID: state.runID,
      runDirectory: resolve(this.options.runDirectory),
      returnProfileDigest: this.options.selection.returnProfileDigest,
      ...(ready
        ? {lastVerification: {runDirectory: resolve(this.options.runDirectory), sequence: this.journal.sequence}}
        : {}),
    }
    await atomicJson(join(this.options.fixtureDirectory, "fixture.json"), fixture)
    return result
  }
}

async function withOwnership(options: LifecycleOptions, recovering: boolean): Promise<LifecycleResult> {
  options = {...options, selection: structuredClone(options.selection)}
  definition(options.routine)
  if (!options.selection.runID || !options.selection.fixtureID || !options.selection.returnProfileDigest)
    throw new Error("Resolved run, physical fixture and return-profile identities are required")
  const release = await options.acquireLease()
  try {
    await mkdir(options.fixtureDirectory, {recursive: true, mode: 0o700})
    const fixturePath = join(options.fixtureDirectory, "fixture.json")
    const fixture = await jsonFile<FixtureRecord>(fixturePath)
    if (fixture !== undefined) validFixture(fixture, options.selection.fixtureID)
    const descriptor = {
      schemaVersion: 1,
      selection: options.selection,
      routine: {id: options.routine.id, definitionDigest: options.routine.definitionDigest},
    }
    let journal: Journal
    if (recovering) {
      if (
        !fixture ||
        fixture.status === "ready" ||
        fixture.runID !== options.selection.runID ||
        fixture.runDirectory !== resolve(options.runDirectory) ||
        fixture.returnProfileDigest !== options.selection.returnProfileDigest
      )
        throw new Error("Recovery requires the owning unavailable fixture and its frozen run inputs")
      const stored = await jsonFile(join(options.runDirectory, "run.json"))
      if (!isDeepStrictEqual(stored, descriptor)) throw new Error("Recovery inputs or routine definition changed")
      journal = await Journal.resume(options.runDirectory, options.selection.runID)
      journal.state.mode = "recovering"
      await journal.append("recovery-started")
    } else {
      if (fixture && fixture.status !== "ready")
        throw new Error(
          `Fixture is ${fixture.status}, owned by ${fixture.runID}; recover it before starting another run`,
        )
      await mkdir(options.runDirectory, {recursive: false, mode: 0o700})
      await atomicJson(join(options.runDirectory, "run.json"), descriptor)
      journal = new Journal(options.runDirectory, {
        schemaVersion: 1,
        runID: options.selection.runID,
        phase: "preflight",
        mode: "running",
        phases: Object.fromEntries(phases.map((phase) => [phase, "not-run"])) as LifecycleState["phases"],
        testStarted: false,
        testFrozen: false,
        test: "not-run",
        operations: [],
      })
      await journal.append("run-started")
      await atomicJson(fixturePath, {
        schemaVersion: 1,
        fixtureID: options.selection.fixtureID,
        status: "busy",
        runID: options.selection.runID,
        runDirectory: resolve(options.runDirectory),
        returnProfileDigest: options.selection.returnProfileDigest,
      } satisfies FixtureRecord)
    }
    const execution = new Execution(options, journal)
    if (recovering) {
      await execution.freezeTest(
        journal.state.testStarted ? "failed" : "not-run",
        "Process ended before the test verdict was frozen",
      )
      await execution.recoverPending().catch(async (error) => {
        await journal.append("reconciliation-failed", {error: errorText(error)})
      })
    } else {
      try {
        for (const phase of ["preflight", "setup", "test", "final-assertions"] as const)
          await execution.phase(phase, true)
        await execution.freezeTest("passed")
      } catch (error) {
        await execution.freezeTest(
          error instanceof Cancelled ? "cancelled" : journal.state.testStarted ? "failed" : "not-run",
          errorText(error),
        )
      }
    }
    return await execution.finish()
  } finally {
    // Releasing the OS/process lease never clears a busy or recovery-required fixture record.
    await release()
  }
}

export function runLifecycle(options: LifecycleOptions) {
  return withOwnership(options, false)
}

/** Reconcile unfinished work, then restore/verify. Never restarts setup or the customer test. */
export function recoverLifecycle(options: LifecycleOptions) {
  return withOwnership(options, true)
}
