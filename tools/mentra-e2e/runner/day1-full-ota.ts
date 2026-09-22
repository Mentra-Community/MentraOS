import {isAbsolute, join, normalize} from "node:path"
import type {Json, LifecycleContext, MutationIntent, MutationStep, Reconciliation} from "./lifecycle"

export type Day1FullOtaPhase = "stage" | "activate"
export interface Day1FullOtaInputs {
  /** Frozen, private config; the Python adapter validates its bytes and complete definition. */
  config: {path: string; sha256: string}
  python: string
  adapterDirectory: string
}

/** Actual observations from the trusted routine's existing readers, never request JSON. */
export interface Day1FullOtaCurrentState {
  startedAt: number
  finishedAt: number
  bootBefore: string
  bootAfter: string
  /** Exact source_identity() or recovery.identity() result; Python is the schema authority. */
  identity: {[key: string]: Json}
  engineStatus: string
  /** Required for target proof; the log must close these identity/engine reads. */
  stateReadsFinishedAt?: number
  januaryLog?: {
    text: string
    pidBefore: string
    pidAfter: string
    startTicksBefore: string
    startTicksAfter: string
    bootEpoch: number
    deviceEpoch: number
    capturedAt: number
  }
}

export interface Day1FullOtaRuntimeContext {
  lifecycle: LifecycleContext
  phase: Day1FullOtaPhase
  /** Must remain absent until stage creates it; keep observation logs in a sibling directory. */
  adapterRunDirectory: string
  /** Original stage lifecycle operation, including during activation. */
  stageOwner: string | null
}

export interface Day1FullOtaInvocation extends Day1FullOtaRuntimeContext {
  kind: "mutation" | "reconciliation"
  argv: string[]
  /** Only the fixed read-only Python bridge accepts input. Keep its raw log data private. */
  stdin?: string
  lifecycleOperationID?: string
}

export interface Day1FullOtaRuntime {
  /** Capture fresh bracketed reads and their private evidence beneath the caller's lease. */
  readCurrentState(context: Day1FullOtaRuntimeContext): Promise<{
    current: Day1FullOtaCurrentState
    evidence: string[]
  }>
  /** Spawn directly from the lease owner (no shell/second worker). Record argv, times,
   * exact exit status and raw output privately, including failures. Never retry or
   * abort a dispatched firmware writer to satisfy a routine timeout. */
  invoke(command: Day1FullOtaInvocation): Promise<{
    exitCode: number
    stdout: string
    evidence: string[]
  }>
}

const stageID = "day1-full-ota-stage"
const activateID = "day1-full-ota-activate"
const adapter = "january-20260113-powerwash-asg27"
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/
const states = new Set(["settled", "satisfied", "active", "unknown"])

// A fixed read-only bridge, not a configurable command or an additional workflow.
// The loaded config pins reconcile.py before it is imported. stdin is data only.
const reconcilePython = `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import config
cfg = config.load(sys.argv[2], sys.argv[3])
import reconcile
current = json.load(sys.stdin)
print(json.dumps(reconcile.reconcile(sys.argv[4], cfg, Path(sys.argv[5]), current), allow_nan=False))
`

function absolute(path: string) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || /[\0\r\n]/.test(path))
    throw new Error("January adapter paths must be absolute and normalized")
  return path
}

function evidence(paths: string[]) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || !path.trim()))
    throw new Error("January adapter runtime omitted command or observation evidence")
  return paths
}

function operation(context: LifecycleContext, id: string) {
  const matches = context.operations.filter((item) => item.stepID === id)
  if (matches.length > 1) throw new Error("January setup has ambiguous lifecycle ownership")
  const value = matches[0]
  if (value && (value.phase !== "setup" || !uuid.test(value.operationID)))
    throw new Error("January setup requires its original setup operation UUID")
  return value
}

/**
 * Two setup mutations only. Construction performs no I/O; runLifecycle owns the
 * intent, sole lease and all retry/recovery policy. Runtime callbacks are trusted
 * local code registered by the worker, never commands taken from a CI request.
 * Keep these step IDs unchanged so activation can locate the original stage.
 */
export function createDay1FullOtaSteps(
  inputs: Day1FullOtaInputs,
  runtime: Day1FullOtaRuntime,
): [MutationStep, MutationStep] {
  const frozen = structuredClone(inputs)
  absolute(frozen.config.path)
  absolute(frozen.python)
  absolute(frozen.adapterDirectory)
  if (!/^[a-f\d]{64}$/.test(frozen.config.sha256)) throw new Error("January adapter config SHA-256 is required")
  const configArgs = ["--config", frozen.config.path, "--config-sha256", frozen.config.sha256]

  function binding(context: LifecycleContext, phase: Day1FullOtaPhase): Day1FullOtaRuntimeContext {
    const stage = operation(context, stageID)
    if (phase === "activate" && !stage) throw new Error("January activation has no owning stage intent")
    return {
      lifecycle: context,
      phase,
      adapterRunDirectory: join(absolute(context.runDirectory), "day1-full-ota"),
      stageOwner: stage?.operationID ?? null,
    }
  }

  function intentOwner(context: LifecycleContext, intent: Readonly<MutationIntent>, id: string) {
    const saved = operation(context, id)
    if (!saved || saved.operationID !== intent.operationID || saved.phase !== intent.phase || intent.stepID !== id)
      throw new Error("January dispatch requires the matching durable lifecycle intent")
  }

  function summary(bound: Day1FullOtaRuntimeContext) {
    return {
      adapter,
      phase: bound.phase,
      adapterRunDirectory: bound.adapterRunDirectory,
      configSha256: frozen.config.sha256,
      stageOwner: bound.stageOwner,
      setupOnly: true,
      fixtureReadyForOtherRoutines: false,
    }
  }

  function completedStage(context: LifecycleContext, bound: Day1FullOtaRuntimeContext) {
    const prior = operation(context, stageID)?.reconciliation
    const actual = prior?.actual as ReturnType<typeof summary> | undefined
    if (
      prior?.status !== "satisfied" ||
      !actual ||
      actual.adapter !== adapter ||
      actual.phase !== "stage" ||
      actual.adapterRunDirectory !== bound.adapterRunDirectory ||
      actual.configSha256 !== frozen.config.sha256 ||
      actual.stageOwner !== bound.stageOwner ||
      actual.setupOnly !== true ||
      actual.fixtureReadyForOtherRoutines !== false
    )
      throw new Error("January activation requires the owned stage's successful live reconciliation")
  }

  function step(phase: Day1FullOtaPhase): MutationStep {
    const id = phase === "stage" ? stageID : activateID
    return {
      id,
      kind: "mutation",
      repeat: "never",
      instruction:
        phase === "stage"
          ? "Transfer and apply the verified January full OTA once, preserving its owned stage receipt."
          : "Activate that staged January OTA once, recover its network and verify the factory baseline.",
      async execute(context, intent) {
        intentOwner(context, intent, id)
        const bound = binding(context, phase)
        if (phase === "activate") completedStage(context, bound)
        const argv = [
          frozen.python,
          join(frozen.adapterDirectory, "full_january.py"),
          phase,
          ...configArgs,
          "--run",
          bound.adapterRunDirectory,
          ...(phase === "stage" ? ["--owner", intent.operationID] : []),
        ]
        const result = await runtime.invoke({
          ...bound,
          kind: "mutation",
          argv,
          lifecycleOperationID: intent.operationID,
        })
        if (!Number.isInteger(result.exitCode))
          throw new Error("January adapter runtime omitted the process exit status")
        // A command failure is preserved, then runLifecycle performs fresh reconciliation.
        // Exit zero itself is never a setup or firmware success assertion.
        return {
          ...summary(bound),
          lifecycleOperationID: intent.operationID,
          exitCode: result.exitCode,
          evidence: evidence(result.evidence),
        }
      },
      async reconcile(context, intent) {
        if (intent) intentOwner(context, intent, id)
        const bound = binding(context, phase)
        if (phase === "activate") completedStage(context, bound)
        const started = Date.now() / 1000
        const observation = await runtime.readCurrentState(bound)
        const current = observation.current
        if (
          !Number.isFinite(current.startedAt) ||
          !Number.isFinite(current.finishedAt) ||
          current.startedAt < started - 1 ||
          current.finishedAt < current.startedAt ||
          current.finishedAt > Date.now() / 1000 + 1
        )
          throw new Error("January adapter requires a fresh caller-owned observation")
        evidence(observation.evidence)
        const result = await runtime.invoke({
          ...bound,
          kind: "reconciliation",
          argv: [
            frozen.python,
            "-c",
            reconcilePython,
            frozen.adapterDirectory,
            frozen.config.path,
            frozen.config.sha256,
            phase,
            bound.adapterRunDirectory,
          ],
          stdin: JSON.stringify(current),
        })
        evidence(result.evidence)
        if (result.exitCode !== 0 || typeof result.stdout !== "string" || result.stdout.length > 65536)
          throw new Error("January receipt reconciliation failed; inspect the private command evidence")
        const value = JSON.parse(result.stdout)
        if (
          !value ||
          !states.has(value.status) ||
          typeof value.reason !== "string" ||
          !/^[a-z0-9_]{1,160}$/.test(value.reason) ||
          !(value.owner === null || (typeof value.owner === "string" && uuid.test(value.owner))) ||
          value.setupOnly !== true ||
          value.fixtureReadyForOtherRoutines !== false ||
          !Array.isArray(value.evidence) ||
          value.evidence.some((path: unknown) => typeof path !== "string" || !path.trim())
        )
          throw new Error("January receipt reconciliation returned an invalid scoped result")
        let status: Reconciliation["status"] = value.status
        // Never adopt another run's receipt or skip a stage without this lifecycle's intent.
        if (status !== "unknown" && value.owner !== bound.stageOwner) status = "unknown"
        if (phase === "stage" && !intent && status !== "settled") status = "unknown"
        return {
          status,
          expected: {...summary(bound), currentStateRequired: true},
          actual: {
            ...summary(bound),
            status,
            reason: status === value.status ? value.reason : "lifecycle_owner_mismatch",
            receiptOwner: value.owner,
          },
          observedAt: new Date(current.finishedAt * 1000).toISOString(),
          source: "January adapter receipts and fresh caller-owned device observation",
          evidence: [...new Set([...observation.evidence, ...result.evidence, ...value.evidence])],
          identity: {fixtureID: context.selection.fixtureID, boot: current.bootAfter},
        }
      },
    }
  }
  return [step("stage"), step("activate")]
}
