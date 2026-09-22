import {createHash} from "node:crypto"
import {constants} from "node:fs"
import {open} from "node:fs/promises"
import {isAbsolute, join, normalize} from "node:path"
import {isDeepStrictEqual} from "node:util"
import {firmwareTransport, type FirmwareFixture, type FirmwareProfile} from "./firmware-profile"
import {normalizeFirmware} from "./ota-state"
import type {
  AssertionObservation,
  Json,
  LifecycleContext,
  MutationIntent,
  MutationStep,
  Observation,
  Reconciliation,
} from "./lifecycle"

export type MtkRestoreIdentity = {
  cid: string
  serial: string
  bootSerial: string
  bluetooth: string
  firmware: string
  bootId: string
  slot: string
  bootCompleted: boolean
  transport: string
  usb?: string
  wifiEndpoint?: string
}
export interface MtkRestoreObservation extends Observation {
  identity: MtkRestoreIdentity
  engineStatus: string
  /** Competing ASG/BES/app/stream work is idle. The owned MTK engine state is
   * checked separately, including READY before activation. */
  writersIdle: boolean
  powerReady: boolean
}
export interface MtkFullRestoreInputs {
  profile: FirmwareProfile
  fixture: FirmwareFixture
  artifact: {path: string; sha256: string; size: number}
  python: string
  helper: {path: string; sha256: string}
  /** Already staged, SHA-named probe. Never replace the generic status JAR. */
  probe: {path: string; sha256: string; remote: string}
}
type FileRef = {path: string; sha256: string}
type Bound = {
  context: LifecycleContext
  intent: Readonly<MutationIntent>
  source: MtkRestoreIdentity
  remote: string
  sourceIntent: FileRef
}
type CommandResult = {exitCode: number; evidence: string[]}
export type MtkStageEvidence = {
  /** Null means the process exit was not captured. Only the original successful
   * helper result plus independently observed READY can establish completion. */
  exitCode: number | null
  sourceIntent: FileRef
  argv: string[]
  preflight: Json
  receipt: Json
  evidence: string[]
}
export interface MtkFullRestoreRuntime {
  read(context: LifecycleContext): Promise<MtkRestoreObservation>
  /** Verify actual cached size/SHA and payload full-image semantics, signature
   * provenance and absence of POWERWASH. Manifest metadata alone is not full proof. */
  verifyArtifact(inputs: Readonly<MtkFullRestoreInputs>, context: LifecycleContext): Promise<AssertionObservation>
  /** Record the owner and exact transfer; invoke beforeWrite immediately before
   * each transfer write. Preserve an ambiguous transfer; never retry it. */
  transfer(request: Bound & {local: string; beforeWrite: () => Promise<void>}): Promise<CommandResult>
  /** Run the pinned helper with these exact argv; persist its original output.
   * Reuse the January wrapper's two exact status-probe path remaps and call
   * beforeApply immediately before its one install broadcast, after transfer.
   * This is trusted local code, never an executable callback from request JSON. */
  stage(
    request: Bound & {argv: string[]; probe: MtkFullRestoreInputs["probe"]; beforeApply: () => Promise<void>},
  ): Promise<MtkStageEvidence>
  /** Read only the original owned output. Validate/return its original command,
   * preflight, result and source-intent ref; never run transfer or the helper.
   * Missing or incomplete output returns null, not an inferred success. */
  readStageEvidence(request: Bound & {outputDirectory: string; argv: string[]}): Promise<MtkStageEvidence | null>
  /** One exact targeted reboot, with beforeReboot immediately before dispatch.
   * Return observation belongs to read(); do not infer success from exit zero. */
  reboot(request: Bound & {argv: string[]; beforeReboot: () => Promise<void>}): Promise<CommandResult>
}
const STAGE = "restore-mtk-stage",
  ACTIVATE = "restore-mtk-activate"
const HELPER_SHA = "00f586a648c96383a9545145d7b44b25bbd2696ce24b8efb166238dde59a8698"
const PROBE_SHA = "c0488244fe62e24f0ca2c855355de01bc687d1d8ae762336e2fc0405e5e42a8e"
const IDLE = "UPDATE_STATUS_IDLE",
  READY = "UPDATE_STATUS_UPDATED_NEED_REBOOT"
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/
const same = isDeepStrictEqual
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
async function evidenceFile(path: string, value?: unknown) {
  const file = await open(
    path,
    (value === undefined ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL) |
      constants.O_NOFOLLOW,
    0o600,
  )
  try {
    if (value !== undefined) {
      await file.writeFile(JSON.stringify(value))
      await file.sync()
      const directory = await open(join(path, ".."), constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    const stat = await file.stat()
    requireProof(stat.isFile() && stat.size <= 1024 * 1024, "Invalid restore evidence file")
    const bytes = value === undefined ? await file.readFile() : Buffer.from(JSON.stringify(value))
    return {ref: {path, sha256: digest(bytes)}, value: JSON.parse(bytes.toString())}
  } finally {
    await file.close()
  }
}
function requireProof(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message)
}
function paths(values: string[]) {
  for (const value of values)
    requireProof(
      isAbsolute(value) && normalize(value) === value && !/[\0\r\n]/.test(value),
      "Restore paths must be absolute and normalized",
    )
}

/** Only MTK restoration. Caller owns the sole lease, resource cleanup and whole
 * fixture return proof. Full OTA is the default and sole method here; flashing
 * requires a separate explicitly selected adapter. No I/O during construction. */
export function createMtkFullRestoreSteps(
  selected: MtkFullRestoreInputs,
  runtime: MtkFullRestoreRuntime,
): [MutationStep, MutationStep] {
  const input = structuredClone(selected),
    target = input.profile.mtk
  paths([input.artifact.path, input.python, input.helper.path, input.probe.path, input.probe.remote])
  firmwareTransport(input.fixture)
  requireProof(
    input.helper.sha256 === HELPER_SHA &&
      input.probe.sha256 === PROBE_SHA &&
      input.probe.remote === `/data/local/tmp/mentra-update-engine-status-${PROBE_SHA}.jar`,
    "Pinned helper/probe required",
  )
  requireProof(
    /^[a-f\d]{64}$/.test(input.profile.manifest.sha256) &&
      /^[a-f\d]{64}$/.test(target.artifact.sha256) &&
      input.artifact.sha256 === target.artifact.sha256 &&
      input.artifact.size === target.artifact.size &&
      Number.isSafeInteger(input.artifact.size) &&
      input.artifact.size > 0 &&
      input.artifact.size <= 1024 * 1024 * 1024,
    "Selected full OTA artifact mismatch",
  )
  requireProof(
    /^[a-f\d]{32}$/i.test(input.fixture.cid) &&
      /^(?:[a-f\d]{2}:){5}[a-f\d]{2}$/i.test(input.fixture.bluetooth) &&
      input.fixture.serials.length > 0,
    "Exact fixture required",
  )
  const binding = {
    manifest: input.profile.manifest.sha256,
    version: target.version,
    sha256: target.artifact.sha256,
    size: input.artifact.size,
  }
  const inputDigest = digest(JSON.stringify(input))
  const own = (c: LifecycleContext, id: string, intent?: Readonly<MutationIntent>) => {
    const all = c.operations.filter((op) => op.stepID === id),
      op = all[0]
    requireProof(
      all.length <= 1 && (!op || (op.phase === "teardown" && uuid.test(op.operationID))),
      "Ambiguous restore ownership",
    )
    if (intent)
      requireProof(
        op?.operationID === intent.operationID && intent.phase === "teardown" && intent.stepID === id,
        "Restore needs its durable teardown intent",
      )
    return op
  }
  const identity = (v: MtkRestoreIdentity) => {
    requireProof(
      v.cid.toLowerCase() === input.fixture.cid.toLowerCase() &&
        v.bluetooth.toUpperCase() === input.fixture.bluetooth.toUpperCase() &&
        input.fixture.serials.includes(v.serial) &&
        input.fixture.serials.includes(v.bootSerial) &&
        uuid.test(v.bootId) &&
        ["_a", "_b"].includes(v.slot) &&
        v.bootCompleted === true &&
        /^\d+$/.test(v.transport) &&
        v.usb === input.fixture.usb &&
        v.wifiEndpoint === input.fixture.wifiEndpoint,
      "Restore fixture identity changed",
    )
  }
  const read = async (c: LifecycleContext) => {
    const started = Date.now(),
      value = await runtime.read(c),
      at = Date.parse(value.observedAt)
    requireProof(
      Number.isFinite(at) &&
        at >= started - 1000 &&
        at <= Date.now() + 1000 &&
        value.evidence.length > 0 &&
        value.source.trim(),
      "Fresh restore evidence required",
    )
    identity(value.identity)
    return value
  }
  const targetIdle = (v: MtkRestoreObservation) =>
    normalizeFirmware(v.identity.firmware) === normalizeFirmware(target.version) &&
    v.engineStatus === IDLE &&
    v.writersIdle === true
  const gate = async (c: LifecycleContext, source: MtkRestoreIdentity, status: string) => {
    const v = await read(c)
    requireProof(
      same(v.identity, source) && v.engineStatus === status && v.writersIdle === true && v.powerReady === true,
      "Restore source, idle or power gate changed",
    )
  }
  const output = (c: LifecycleContext, op: Readonly<MutationIntent>) =>
    join(c.runDirectory, `mtk-full-${op.operationID}`)
  const remotePath = (op: Readonly<MutationIntent>) => `/storage/emulated/0/asg/mentra-restore-${op.operationID}.zip`
  const argv = (c: LifecycleContext, op: Readonly<MutationIntent>, source: MtkRestoreIdentity) => [
    input.python,
    input.helper.path,
    "--transport",
    source.transport,
    ...(source.usb ? ["--usb-path", source.usb] : ["--wifi-endpoint", source.wifiEndpoint!]),
    "--expected-version",
    source.firmware,
    "--expected-emmc-cid",
    input.fixture.cid.toLowerCase(),
    "--remote",
    remotePath(op),
    "--size",
    String(input.artifact.size),
    "--sha256",
    target.artifact.sha256,
    "--output",
    output(c, op),
    "--update-engine-status-jar",
    input.probe.path,
  ]
  const original = (c: LifecycleContext, op: Readonly<MutationIntent>, source: MtkRestoreIdentity) => ({
    kind: "mtk-full-source/v1",
    operationID: op.operationID,
    startedAt: op.startedAt,
    runDirectory: c.runDirectory,
    inputDigest,
    target: binding,
    source,
    remote: remotePath(op),
  })
  const helperIdentity = (source: MtkRestoreIdentity) => ({
    version: source.firmware,
    slot: source.slot,
    serial: source.serial,
    emmc_cid: source.cid.toLowerCase(),
    boot_id: source.bootId,
    transport: source.transport,
    usb_path: source.usb ?? null,
    wifi_endpoint: source.wifiEndpoint ?? null,
  })
  const saved = async (c: LifecycleContext, op?: MutationIntent) => {
    if (!op) return undefined
    let sourceFile, applyFile
    try {
      sourceFile = await evidenceFile(`${output(c, op)}.intent.json`)
      applyFile = await evidenceFile(`${output(c, op)}.apply-intent.json`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    const source = sourceFile.value.source as MtkRestoreIdentity
    identity(source)
    const expectedArgv = argv(c, op, source)
    requireProof(
      same(sourceFile.value, original(c, op, source)) &&
        same(applyFile.value, {sourceIntent: sourceFile.ref, argv: expectedArgv}),
      "Foreign restore source/apply intent",
    )
    const stored = op.dispatch as any
    if (stored !== undefined)
      requireProof(
        stored?.kind === "mtk-full-stage/v1" &&
          stored.operationID === op.operationID &&
          same(stored.target, binding) &&
          same(stored.source, source) &&
          stored.remote === remotePath(op),
        "Foreign restore stage receipt",
      )
    const result: MtkStageEvidence | null =
      stored ??
      (await runtime.readStageEvidence({
        context: c,
        intent: op,
        source,
        remote: remotePath(op),
        sourceIntent: sourceFile.ref,
        outputDirectory: output(c, op),
        argv: expectedArgv,
      }))
    if (!result) return undefined
    requireProof(
      same(result.sourceIntent, sourceFile.ref) && same(result.argv, expectedArgv) && result.evidence.length > 0,
      "Unbound restore stage evidence",
    )
    const preflight = result.preflight as any
    requireProof(
      Object.entries(helperIdentity(source)).every(([key, value]) => preflight?.[key] === value) &&
        preflight.ota_sha256 === binding.sha256 &&
        preflight.ota_size === binding.size &&
        preflight.update_engine?.current_op === IDLE,
      "Restore helper preflight does not match original source",
    )
    return {
      ...result,
      kind: "mtk-full-stage/v1",
      operationID: op.operationID,
      target: binding,
      source,
      remote: remotePath(op),
      applyIntent: applyFile.ref,
      evidence: [...result.evidence, sourceFile.ref.path, applyFile.ref.path],
    }
  }
  const receiptOk = (value: any) =>
    (value?.exitCode === 0 || value?.exitCode === null) &&
    value.receipt?.success === true &&
    value.receipt.ota_sha256 === target.artifact.sha256 &&
    value.receipt.source_version === value.source.firmware &&
    value.receipt.source_slot === value.source.slot &&
    same(value.receipt.post_identity, helperIdentity(value.source)) &&
    value.receipt.post_update_engine?.current_op === READY &&
    typeof value.receipt.log_boundary === "string" &&
    value.receipt.log_boundary.length > 0
  const activatedTarget = (c: LifecycleContext, value: any, v: MtkRestoreObservation) => {
    const activation = own(c, ACTIVATE),
      result = activation?.dispatch as any
    if (result !== undefined)
      requireProof(
        result?.kind === "mtk-full-activation/v1" &&
          result.operationID === activation!.operationID &&
          result.stageOwner === value.operationID,
        "Foreign restore activation receipt",
      )
    return (
      !!activation &&
      targetIdle(v) &&
      v.identity.bootId !== value.source.bootId &&
      v.identity.slot === (value.source.slot === "_a" ? "_b" : "_a")
    )
  }
  const observe = (v: MtkRestoreObservation, status: Reconciliation["status"], extra: Json): Reconciliation => ({
    ...v,
    status,
    expected: "Selected MTK full image and independently verified idle boot",
    actual: {current: v.actual, restore: extra},
  })
  const stage: MutationStep = {
    id: STAGE,
    kind: "mutation",
    repeat: "never",
    instruction: "Stage the selected non-wiping full MTK OTA once.",
    async reconcile(c, intent) {
      const op = own(c, STAGE, intent),
        value = await saved(c, op),
        v = await read(c)
      if (!op)
        return observe(
          v,
          targetIdle(v)
            ? "satisfied"
            : v.engineStatus === IDLE && v.writersIdle && v.powerReady
              ? "settled"
              : "unknown",
          null,
        )
      return observe(
        v,
        value &&
          receiptOk(value) &&
          ((same(v.identity, value.source) && v.engineStatus === READY && v.writersIdle) ||
            activatedTarget(c, value, v))
          ? "satisfied"
          : "unknown",
        value ?? null,
      )
    },
    async execute(c, intent) {
      const op = own(c, STAGE, intent)
      requireProof(op?.dispatch === undefined && !op?.dispatchError, "Restore stage cannot be resent")
      const checked = await runtime.verifyArtifact(input, c)
      requireProof(
        checked.passed === true && checked.evidence.length > 0,
        "Full non-wiping payload verification required",
      )
      const source = (await read(c)).identity
      await gate(c, source, IDLE)
      const remote = remotePath(intent),
        sourceIntent = (await evidenceFile(`${output(c, intent)}.intent.json`, original(c, intent, source))).ref,
        bound = {context: c, intent, source, remote, sourceIntent}
      let transferGated = false,
        applyGated = false
      const transfer = await runtime.transfer({
        ...bound,
        local: input.artifact.path,
        beforeWrite: async () => {
          await gate(c, source, IDLE)
          transferGated = true
        },
      })
      requireProof(
        transfer.exitCode === 0 && transferGated && transfer.evidence.length > 0,
        "Transfer unverified; do not resend",
      )
      await gate(c, source, IDLE) // Close the potentially long transfer before the helper starts.
      const command = argv(c, intent, source)
      const result = await runtime.stage({
        ...bound,
        argv: command,
        probe: input.probe,
        beforeApply: async () => {
          requireProof(!applyGated, "Apply gate already used")
          await gate(c, source, IDLE)
          await evidenceFile(`${output(c, intent)}.apply-intent.json`, {sourceIntent, argv: command})
          applyGated = true
        },
      })
      requireProof(applyGated && result.evidence.length > 0, "Apply dispatch lacks its final gate/evidence")
      return {
        ...result,
        kind: "mtk-full-stage/v1",
        operationID: intent.operationID,
        target: binding,
        source,
        remote,
      } as unknown as Json
    },
  }
  const activate: MutationStep = {
    id: ACTIVATE,
    kind: "mutation",
    repeat: "never",
    instruction: "Activate the owned full MTK OTA once, then verify the new target boot.",
    async reconcile(c, intent) {
      const op = own(c, ACTIVATE, intent),
        staged = await saved(c, own(c, STAGE)),
        v = await read(c)
      if (!staged) return observe(v, !op && targetIdle(v) ? "satisfied" : "unknown", null)
      if (!receiptOk(staged)) return observe(v, "unknown", null)
      const sameSource = same(v.identity, staged.source)
      const complete = activatedTarget(c, staged, v)
      return observe(
        v,
        complete
          ? "satisfied"
          : !op && sameSource && v.engineStatus === READY && v.writersIdle && v.powerReady
            ? "settled"
            : "unknown",
        {stageOwner: staged.operationID, sourceBoot: staged.source.bootId, target: binding},
      )
    },
    async execute(c, intent) {
      const op = own(c, ACTIVATE, intent),
        staged = await saved(c, own(c, STAGE))
      requireProof(
        op?.dispatch === undefined && !op?.dispatchError && staged && receiptOk(staged),
        "Activation needs its original verified stage; never resend",
      )
      await gate(c, staged.source, READY)
      let gated = false
      const result = await runtime.reboot({
        context: c,
        intent,
        source: staged.source,
        remote: staged.remote,
        sourceIntent: staged.sourceIntent,
        argv: ["adb", "-t", staged.source.transport, "reboot"],
        beforeReboot: async () => {
          requireProof(!gated, "Reboot gate already used")
          await gate(c, staged.source, READY)
          gated = true
        },
      })
      requireProof(gated && result.evidence.length > 0, "Reboot lacks its final gate/evidence")
      return {
        kind: "mtk-full-activation/v1",
        operationID: intent.operationID,
        stageOwner: staged.operationID,
        ...result,
      }
    },
  }
  return [stage, activate]
}
