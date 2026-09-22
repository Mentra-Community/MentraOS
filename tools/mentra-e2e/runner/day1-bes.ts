import {randomUUID} from "node:crypto"
import {isAbsolute, join, normalize} from "node:path"
import type {Json, LifecycleContext, MutationIntent, MutationStep, Reconciliation} from "./lifecycle"

export interface Day1BesInputs {
  config: {path: string; sha256: string}
  python: string
  adapterDirectory: string
}

/** Canonical Python reconciliation validates the complete identity and native log. */
export interface Day1BesCurrentState {
  schemaVersion: 1
  observationOwner: string
  firmwareWrites: 0
  startedAt: number
  finishedAt: number
  bootBefore: string
  bootAfter: string
  pidBefore: string
  pidAfter: string
  startTicksBefore: string
  startTicksAfter: string
  endpoint: string
  observed: {[key: string]: Json}
  logCapturedAt: number
  log: {path: string; sha256: string}
}

export interface Day1BesRuntimeContext {
  lifecycle: LifecycleContext
  /** Remains absent until the single install; observations use sibling paths. */
  adapterRunDirectory: string
  lifecycleOwner: string | null
  /** Stable read-only identity before intent; the actual lifecycle UUID afterward. */
  observationOwner: string
}

export interface Day1BesInvocation extends Day1BesRuntimeContext {
  kind: "mutation" | "reconciliation"
  argv: string[]
  stdin?: string
}

export interface Day1BesRuntime {
  readCurrentState(context: Day1BesRuntimeContext): Promise<{current: Day1BesCurrentState; evidence: string[]}>
  invoke(command: Day1BesInvocation): Promise<{exitCode: number; stdout: string; evidence: string[]}>
}

const stepID = "day1-bes-install"
const adapter = "compact-january-bes-v1"
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/
const sha = /^[a-f\d]{64}$/
const states = new Set(["settled", "satisfied", "active", "unknown"])

// Fixed read-only bridge. The frozen config authenticates the definition before
// reconciliation is imported; stdin is observation data, never executable code.
const reconcilePython = `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import config
cfg = config.load(sys.argv[2], sys.argv[3])
cfg.require_lease()
import reconcile
current = json.load(sys.stdin)
print(json.dumps(reconcile.reconcile(cfg, Path(sys.argv[4]), sys.argv[5], current), allow_nan=False))
`

function absolute(path: string) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || /[\0\r\n]/.test(path))
    throw new Error("BES adapter paths must be absolute and normalized")
  return path
}

function evidence(paths: string[], allowEmpty = false) {
  if (!Array.isArray(paths) || (!allowEmpty && !paths.length)) throw new Error("BES runtime evidence is required")
  paths.forEach(absolute)
  return paths
}

/** One existing setup mutation. This factory owns no lease, claims, retries or
 * hardware; runLifecycle journals its intent before the Python adapter can run. */
export function createDay1BesStep(inputs: Day1BesInputs, runtime: Day1BesRuntime): MutationStep {
  const selected = structuredClone(inputs)
  for (const path of [selected.config.path, selected.python, selected.adapterDirectory]) absolute(path)
  if (!sha.test(selected.config.sha256)) throw new Error("BES adapter config SHA-256 is required")
  const readOwner = randomUUID()

  function binding(context: LifecycleContext, intent?: Readonly<MutationIntent>): Day1BesRuntimeContext {
    const matches = context.operations.filter((item) => item.stepID === stepID)
    const saved = matches[0]
    if (
      matches.length > 1 ||
      (saved && (saved.phase !== "setup" || !uuid.test(saved.operationID))) ||
      (saved && !intent) ||
      (intent &&
        (!saved || saved.operationID !== intent.operationID || intent.stepID !== stepID || intent.phase !== "setup"))
    )
      throw new Error("BES setup requires its matching durable setup intent")
    return {
      lifecycle: context,
      adapterRunDirectory: join(absolute(context.runDirectory), "day1-bes"),
      lifecycleOwner: saved?.operationID ?? null,
      observationOwner: saved?.operationID ?? readOwner,
    }
  }

  function summary(bound: Day1BesRuntimeContext) {
    return {
      adapter,
      adapterRunDirectory: bound.adapterRunDirectory,
      configSha256: selected.config.sha256,
      lifecycleOwner: bound.lifecycleOwner,
      observationOwner: bound.observationOwner,
      setupOnly: true,
      fixtureReadyForOtherRoutines: false,
    }
  }

  return {
    id: stepID,
    kind: "mutation",
    repeat: "never",
    instruction:
      "Install the verified compact January BES once, preserving its native owner and fresh completion proof.",
    async execute(context, intent) {
      const bound = binding(context, intent)
      const result = await runtime.invoke({
        ...bound,
        kind: "mutation",
        argv: [
          selected.python,
          join(selected.adapterDirectory, "run.py"),
          "install",
          "--config",
          selected.config.path,
          "--config-sha256",
          selected.config.sha256,
          "--owner",
          intent.operationID,
          "--run",
          bound.adapterRunDirectory,
        ],
      })
      if (!Number.isInteger(result.exitCode)) throw new Error("BES runtime omitted the process exit status")
      // Preserve failure; neither exit zero nor the install observer replaces a
      // fresh reconciliation of the native owner, current boot and actual target.
      return {...summary(bound), exitCode: result.exitCode, evidence: evidence(result.evidence)}
    },
    async reconcile(context, intent) {
      const bound = binding(context, intent)
      const started = Date.now() / 1000
      const observation = await runtime.readCurrentState(bound)
      const current = observation.current
      if (
        current.schemaVersion !== 1 ||
        current.firmwareWrites !== 0 ||
        current.observationOwner !== bound.observationOwner ||
        !Number.isFinite(current.startedAt) ||
        !Number.isFinite(current.finishedAt) ||
        current.startedAt < started - 1 ||
        current.finishedAt < current.startedAt ||
        current.finishedAt > Date.now() / 1000 + 1
      )
        throw new Error("BES setup requires a fresh owner-bound observation")
      evidence(observation.evidence)
      const result = await runtime.invoke({
        ...bound,
        kind: "reconciliation",
        argv: [
          selected.python,
          "-c",
          reconcilePython,
          selected.adapterDirectory,
          selected.config.path,
          selected.config.sha256,
          bound.adapterRunDirectory,
          bound.observationOwner,
        ],
        stdin: JSON.stringify(current),
      })
      evidence(result.evidence)
      if (result.exitCode !== 0 || typeof result.stdout !== "string" || result.stdout.length > 65536)
        throw new Error("BES reconciliation failed; inspect the private command evidence")
      const value = JSON.parse(result.stdout)
      if (
        !value ||
        !states.has(value.status) ||
        typeof value.reason !== "string" ||
        !/^[a-z0-9_]{1,160}$/.test(value.reason) ||
        typeof value.lifecycleOwner !== "string" ||
        !uuid.test(value.lifecycleOwner) ||
        !(
          value.nativeOwner === null ||
          (typeof value.nativeOwner === "string" && /^adb-bes-[a-f\d]{32}$/.test(value.nativeOwner))
        ) ||
        value.setupOnly !== true ||
        value.fixtureReadyForOtherRoutines !== false
      )
        throw new Error("BES reconciliation returned an invalid scoped result")
      evidence(value.evidence, true)
      let status: Reconciliation["status"] = value.status
      if (value.lifecycleOwner !== bound.observationOwner || (!intent && status !== "settled")) status = "unknown"
      let continuityInput: Json = null
      if (status === "satisfied") {
        const proof = value.continuityInput
        if (
          !proof ||
          proof.schemaVersion !== 1 ||
          proof.kind !== "verified-install-continuity" ||
          proof.sourceBoot !== current.bootAfter ||
          !uuid.test(proof.sourceBoot) ||
          !value.nativeOwner ||
          proof.besOwner !== value.nativeOwner ||
          proof.installIntent?.path !== join(bound.adapterRunDirectory, "dispatch", "install-intent.json") ||
          proof.installLog?.path !== join(bound.adapterRunDirectory, "handshake.log") ||
          ![proof.installLog.path, current.log.path].includes(proof.versionLog?.path) ||
          ![proof.installIntent, proof.installLog, proof.versionLog].every(
            (ref) => typeof ref?.sha256 === "string" && sha.test(ref.sha256),
          )
        )
          throw new Error("BES completion omitted its owned continuity proof")
        continuityInput = structuredClone(proof)
      }
      return {
        status,
        expected: {...summary(bound), currentNativeProofRequired: true},
        actual: {
          ...summary(bound),
          status,
          reason: status === value.status ? value.reason : "lifecycle_owner_mismatch",
          nativeOwner: value.nativeOwner,
          originalFailurePreserved: value.originalFailurePreserved === true,
          continuityInput,
        },
        observedAt: new Date(current.finishedAt * 1000).toISOString(),
        source: "BES native owner receipts and fresh bracketed current device observation",
        evidence: [...new Set([...observation.evidence, ...result.evidence, ...value.evidence])],
        identity: {fixtureID: context.selection.fixtureID, boot: current.bootAfter},
      }
    },
  }
}
