import {createHash} from "node:crypto"
import {constants} from "node:fs"
import {mkdir, open, lstat} from "node:fs/promises"
import {dirname, isAbsolute, join, normalize} from "node:path"
import {isDeepStrictEqual as same} from "node:util"
import {verifyBuildManifest} from "./build-manifest"
import {
  ciRecordingBinding,
  exportCiRun,
  finalizeCiRecording,
  type CiExportInputs,
  type FrozenFile,
} from "./ci-run-exporter"
import {createDay1BesStep, type Day1BesInputs, type Day1BesRuntime} from "./day1-bes"
import {createDay1FullOtaSteps, type Day1FullOtaInputs, type Day1FullOtaRuntime} from "./day1-full-ota"
import {parseFirmwareProfile, type FirmwareFixture, type FirmwareProfile} from "./firmware-profile"
import type {AssertionStep, Json, LifecycleContext, LifecycleRoutine, LifecycleStep, MutationStep} from "./lifecycle"
import {createMtkFullRestoreSteps, type MtkFullRestoreInputs, type MtkFullRestoreRuntime} from "./mtk-full-restore"
import {createOtaCustomerStep, type OtaCustomerStepRuntime} from "./ota-customer-step"
import type {ChapterPhase} from "./recorded-evidence"
import type {collectReturnObservation} from "./return-collector"

export interface Day1RoutineInputs {
  appManifest: FrozenFile
  manifest: FrozenFile
  profile: FirmwareProfile
  fixture: FirmwareFixture
  returnProfileDigest: string
  /** Actual source pins for this composition and its dependencies; local code only. */
  sources: FrozenFile[]
  /** Source implementing the injected local readers/recording/runtime callbacks. */
  runtimeSource: FrozenFile
  bes: Day1BesInputs
  /** Exact full-January config except besInstallProof, which is derived after BES. */
  january: {template: FrozenFile; python: string; adapterDirectory: string}
  restore: MtkFullRestoreInputs
}
export interface Day1RoutineRuntime {
  bes: Day1BesRuntime
  january(inputs: Day1FullOtaInputs): Day1FullOtaRuntime
  customer: OtaCustomerStepRuntime
  restore: MtkFullRestoreRuntime
  /** Actual selected app/host/fixture checks, under the outer lifecycle lease. */
  preflight: AssertionStep[]
  beforeSetup: LifecycleStep[]
  /** Launch the selected app, then start native customer capture here. */
  beforeCustomer: LifecycleStep[]
  /** Park/finish capture before any owned app stop; never fabricate absent-window frames. */
  beforeRestore: LifecycleStep[]
  afterRestore: LifecycleStep[]
  /** The existing combined collector's actual result and private evidence. */
  collectReturn(context: LifecycleContext): Promise<{
    result: Awaited<ReturnType<typeof collectReturnObservation>>
    evidence: string[]
  }>
  recording: {
    ci: CiExportInputs
    /** Bind report metadata only. Native window capture starts after beforeCustomer launches the app. */
    bind(context: LifecycleContext, binding: Awaited<ReturnType<typeof ciRecordingBinding>>): Promise<void>
    /** Finish Report before returning; no lifecycle verdict is inferred from it. */
    finish(
      context: LifecycleContext,
    ): Promise<{reportDirectory: string; harnessDirectory: string; phaseByStep: Record<string, ChapterPhase>}>
  }
}

const SHA = /^[a-f\d]{64}$/
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/
const requiredSources = [
  "day1-routine.ts",
  "day1-bes.ts",
  "day1-bes-runtime.ts",
  "day1-full-ota.ts",
  "day1-full-ota-runtime.ts",
  "day1-mac-app.ts",
  "ota-customer-step.ts",
  "ota-customer-sequence.ts",
  "ota-recording.ts",
  "mtk-full-restore.ts",
  "mtk-full-restore-runtime.ts",
  "return-collector.ts",
  "return-app-observer.ts",
  "return-observer.ts",
  "firmware-profile.ts",
  "lifecycle.ts",
  "ci-run-exporter.ts",
  "recorded-evidence.ts",
  "build-manifest.ts",
]
export const day1RoutineSourcePaths = requiredSources.map((name) => join(import.meta.dir, name))
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
const bytes = (value: unknown) => Buffer.from(canonical(value) + "\n")
function requireThat(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason)
}
function path(value: string) {
  requireThat(
    typeof value === "string" && isAbsolute(value) && normalize(value) === value && !/[\0\r\n]/.test(value),
    "Day-one inputs need normalized absolute paths",
  )
  return value
}
function ref(value: FrozenFile) {
  path(value.path)
  requireThat(SHA.test(value.sha256), "Day-one input hash required")
}
async function read(file: string, privateFile = false) {
  const fd = await open(path(file), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat()
    requireThat(
      before.isFile() &&
        before.nlink === 1 &&
        before.size <= 4 * 1024 * 1024 &&
        (!privateFile || (before.uid === process.getuid?.() && (before.mode & 0o777) === 0o600)),
      "Invalid day-one input file",
    )
    const value = await fd.readFile(),
      after = await fd.stat()
    requireThat(
      value.length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "Day-one input changed while reading",
    )
    return value
  } finally {
    await fd.close()
  }
}
async function frozen(file: FrozenFile, privateFile = false) {
  const value = await read(file.path, privateFile)
  requireThat(hash(value) === file.sha256, "Day-one frozen input changed")
  return value
}
async function createOrMatch(file: string, value: Buffer, mayCreate: boolean) {
  if (!mayCreate) {
    requireThat((await read(file, true)).equals(value), "Deferred January inputs differ from original BES continuity")
    return {path: file, sha256: hash(value)}
  }
  let fd
  try {
    fd = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  if (fd) {
    try {
      await fd.writeFile(value)
      await fd.sync()
    } finally {
      await fd.close()
    }
    const parent = await open(dirname(file), "r")
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  }
  requireThat((await read(file, true)).equals(value), "Deferred January inputs differ from original BES continuity")
  return {path: file, sha256: hash(value)}
}

/** Composition only. The caller supplies the existing lease/CI registration.
 * No scheduler, installation, implicit app stop or transport mutation lives here. */
export function createDay1Routine(input: Day1RoutineInputs, runtime: Day1RoutineRuntime) {
  const selected = structuredClone(input)
  // Snapshot caller-owned step lists; later array edits cannot change the definition.
  const steps = {
    preflight: runtime.preflight.map((step) => ({...step})),
    beforeSetup: runtime.beforeSetup.map((step) => ({...step})),
    beforeCustomer: runtime.beforeCustomer.map((step) => ({...step})),
    beforeRestore: runtime.beforeRestore.map((step) => ({...step})),
    afterRestore: runtime.afterRestore.map((step) => ({...step})),
  }
  for (const file of [
    selected.appManifest,
    selected.manifest,
    selected.bes.config,
    selected.january.template,
    selected.runtimeSource,
    ...selected.sources,
  ])
    ref(file)
  for (const file of [selected.january.python, selected.january.adapterDirectory]) path(file)
  requireThat(
    SHA.test(selected.returnProfileDigest) &&
      same(selected.restore.profile, selected.profile) &&
      same(selected.restore.fixture, selected.fixture),
    "Day-one restore must use the selected profile and fixture",
  )
  requireThat(
    selected.profile.manifest.sha256 === selected.manifest.sha256 && runtime.preflight.length > 0,
    "Selected manifest and real preflight are required",
  )
  const sourcePaths = selected.sources.map((file) => file.path)
  requireThat(
    new Set(sourcePaths).size === sourcePaths.length &&
      day1RoutineSourcePaths.every((file) => sourcePaths.includes(file)),
    "Day-one definition omits a required dependency",
  )
  selected.sources.sort((a, b) => a.path.localeCompare(b.path))
  const hooks = Object.fromEntries(
    ["preflight", "beforeSetup", "beforeCustomer", "beforeRestore", "afterRestore"].map((key) => [
      key,
      steps[key as "beforeSetup"].map(({id, kind, instruction, ...step}) => ({
        id,
        kind,
        instruction,
        ...(kind === "mutation" ? {repeat: (step as MutationStep).repeat} : {}),
      })),
    ]),
  )
  // Exclude CI claim bytes: registration contains this digest, then the claim is created.
  const definitionDigest = hash(bytes({schemaVersion: 1, selected, hooks}))
  const adapterInputs = {schemaVersion: 1, kind: "day1-routine/v1", definitionDigest, selected} as unknown as Json
  const expectedContext = (c: LifecycleContext) => {
    const value = c.selection.inputs as {adapter?: Json}
    requireThat(
      c.selection.returnProfileDigest === selected.returnProfileDigest && same(value.adapter, adapterInputs),
      "Lifecycle selection differs from day-one composition",
    )
  }
  const verifyStatic = async (c: LifecycleContext) => {
    expectedContext(c)
    for (const source of [...selected.sources, selected.runtimeSource]) await frozen(source)
    const app = JSON.parse((await frozen(selected.appManifest)).toString())
    verifyBuildManifest(app, {
      bundleId: app.bundleId,
      version: app.version,
      build: app.build,
      executableSha256: app.executableSha256,
      javascriptSha256: app.javascriptSha256,
    })
    requireThat(
      typeof app.pr === "number" && app.otaManifestUrl === selected.profile.manifest.url,
      "Selected app has a different CI OTA manifest",
    )
    const request = (c.selection.inputs as {request?: {selection?: {app?: unknown; otaManifest?: unknown}}}).request
    const requested = request?.selection
    const manifestBytes = await frozen(selected.manifest)
    requireThat(
      requested?.app &&
        typeof requested.app === "object" &&
        !Array.isArray(requested.app) &&
        Object.keys(requested.app).length > 0 &&
        Object.entries(requested.app).every(([key, value]) => same(app[key], value)) &&
        same(requested.otaManifest, {
          url: selected.profile.manifest.url,
          sha256: selected.manifest.sha256,
          size: manifestBytes.length,
        }),
      "Selected app or OTA bytes differ from the consumed CI request",
    )
    requireThat(
      same(parseFirmwareProfile(manifestBytes, selected.profile.manifest), selected.profile),
      "Selected return profile differs from manifest bytes",
    )
    const bes = JSON.parse((await frozen(selected.bes.config, true)).toString())
    const template = JSON.parse((await frozen(selected.january.template, true)).toString())
    requireThat(
      !Object.hasOwn(template, "besInstallProof") &&
        template.python === selected.january.python &&
        bes.fixture.cid === selected.fixture.cid.toLowerCase() &&
        template.fixture.cid === bes.fixture.cid &&
        bes.fixture.mac === selected.fixture.bluetooth.toUpperCase() &&
        template.fixture.mac === bes.fixture.mac &&
        selected.fixture.serials.every(
          (serial) => bes.fixture.serial_aliases.includes(serial) && template.fixture.serialAliases.includes(serial),
        ),
      "January template/BES/selected fixture binding differs",
    )
    return template
  }
  const deferred = async (c: LifecycleContext) => {
    const template = await verifyStatic(c)
    const bes = c.operations.filter((operation) => operation.stepID === "day1-bes-install")
    const prior = bes[0],
      actual = prior?.reconciliation?.actual as any,
      continuity = actual?.continuityInput
    requireThat(
      bes.length === 1 &&
        prior.phase === "setup" &&
        UUID.test(prior.operationID) &&
        prior.reconciliation?.status === "satisfied" &&
        actual.adapter === "compact-january-bes-v1" &&
        actual.configSha256 === selected.bes.config.sha256 &&
        actual.adapterRunDirectory === join(c.runDirectory, "day1-bes") &&
        actual.lifecycleOwner === prior.operationID &&
        actual.setupOnly === true &&
        actual.fixtureReadyForOtherRoutines === false &&
        continuity?.schemaVersion === 1 &&
        continuity.kind === "verified-install-continuity" &&
        UUID.test(continuity.sourceBoot) &&
        continuity.besOwner === actual.nativeOwner,
      "January setup requires persisted same-owner satisfied BES continuity",
    )
    requireThat(
      continuity.installIntent?.path === join(c.runDirectory, "day1-bes/dispatch/install-intent.json") &&
        continuity.installLog?.path === join(c.runDirectory, "day1-bes/handshake.log") &&
        /^adb-bes-[a-f\d]{32}$/.test(continuity.besOwner),
      "BES continuity references another attempt",
    )
    for (const name of ["installIntent", "installLog", "versionLog"]) {
      ref(continuity[name])
      await frozen(continuity[name], true)
    }
    const folder = join(path(c.runDirectory), "day1-january-inputs")
    try {
      await mkdir(folder, {mode: 0o700})
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const info = await lstat(folder)
    requireThat(
      info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700,
      "Deferred input directory must be private",
    )
    const mayCreate = !c.operations.some((operation) => operation.stepID === "day1-full-ota-stage")
    const proof = await createOrMatch(join(folder, "bes-continuity.json"), bytes(continuity), mayCreate)
    const config = await createOrMatch(
      join(folder, "config.json"),
      bytes({...template, besInstallProof: proof}),
      mayCreate,
    )
    const inputs = {config, python: selected.january.python, adapterDirectory: selected.january.adapterDirectory}
    return createDay1FullOtaSteps(inputs, runtime.january(inputs))
  }
  const deferredStep = (index: 0 | 1): MutationStep => ({
    id: index === 0 ? "day1-full-ota-stage" : "day1-full-ota-activate",
    kind: "mutation",
    repeat: "never",
    instruction:
      index === 0
        ? "Stage the January full OTA using the persisted BES continuity."
        : "Activate and verify that owned January stage.",
    execute: async (c, intent) => (await deferred(c))[index].execute(c, intent),
    reconcile: async (c, intent) => (await deferred(c))[index].reconcile(c, intent),
  })
  const selectedEvidence = [
    selected.appManifest.path,
    selected.manifest.path,
    selected.bes.config.path,
    selected.january.template.path,
    ...selected.sources.map((file) => file.path),
    selected.runtimeSource.path,
  ]
  const staticStep: AssertionStep = {
    id: "day1-selected-inputs",
    kind: "assertion",
    instruction: "Verify the frozen selected app, profile, fixture and local routine definition.",
    observe: async (c) => {
      await verifyStatic(c)
      return {
        passed: true,
        expected: "Unchanged selected input and implementation bytes",
        actual: {definitionDigest},
        observedAt: new Date().toISOString(),
        source: "Local frozen input verification; app/fixture readiness is checked separately",
        evidence: selectedEvidence,
      }
    },
  }
  const bindRecording: AssertionStep = {
    id: "day1-recording-binding",
    kind: "assertion",
    instruction: "Bind report metadata to the consumed CI claim before owned setup.",
    observe: async (c) => {
      expectedContext(c)
      const binding = await ciRecordingBinding(runtime.recording.ci)
      requireThat(
        binding.runID === c.selection.runID &&
          binding.fixtureID === c.selection.fixtureID &&
          binding.definitionDigest === definitionDigest &&
          binding.returnProfileDigest === selected.returnProfileDigest,
        "Recording claim differs from this lifecycle",
      )
      await runtime.recording.bind(c, binding)
      return {
        passed: true,
        expected: "Claim-bound report metadata; native capture starts after app launch",
        actual: binding as Json,
        observedAt: new Date().toISOString(),
        source: "Registered local recording adapter",
        evidence: [runtime.recording.ci.claim.path],
      }
    },
  }
  const customer = createOtaCustomerStep({
    ...runtime.customer,
    recording: async (c, intent) => {
      const value = await runtime.customer.recording(c, intent)
      requireThat(
        value.selection.install === true &&
          value.selection.resume === false &&
          same(value.selection.target, {
            asgVersion: selected.profile.asg.versionCode,
            firmware: selected.profile.mtk.version,
            bes: selected.profile.bes.version,
          }),
        "Customer sequence differs from selected OTA target",
      )
      return value
    },
  })
  const finalCustomer: AssertionStep = {
    id: "day1-customer-final-target",
    kind: "assertion",
    instruction: "Verify the completed customer sequence's current target and closing idle proof before restoration.",
    observe: async (c) => {
      expectedContext(c)
      const operations = c.operations.filter((operation) => operation.stepID === customer.id)
      requireThat(operations.length === 1, "Customer final assertion requires its original test operation")
      // Existing reconciliation checks original completion/failure and performs new target + idle reads.
      // It neither opens recording actions nor dispatches/replays the customer loop.
      const result = await customer.reconcile(c, operations[0])
      return {...result, passed: result.status === "satisfied"}
    },
  }
  const restore = createMtkFullRestoreSteps(selected.restore, runtime.restore)
  const restoreBarrier: MutationStep = {
    id: "day1-before-restore-idle",
    kind: "mutation",
    repeat: "never",
    instruction: "Reconcile current writers before any restoration app or transport action.",
    execute: async () => {
      throw new Error("The read-only restoration barrier never dispatches")
    },
    reconcile: async (c, intent) => {
      expectedContext(c)
      requireThat(!intent, "The read-only restoration barrier cannot have a dispatch intent")
      const customers = c.operations.filter((operation) => operation.stepID === customer.id)
      const staged = c.operations.filter((operation) => operation.stepID === restore[0].id)
      requireThat(customers.length <= 1 && staged.length <= 1, "Ambiguous customer/restoration ownership")
      const result =
        staged[0] || !customers[0]
          ? await restore[0].reconcile(c, staged[0])
          : await customer.reconcile(c, customers[0])
      // The existing lifecycle retains this pending reconciliation on active/unknown.
      // A settled failed customer permits cleanup, but never changes its test verdict.
      return {
        ...result,
        status: result.status === "settled" ? "satisfied" : result.status,
        expected: "Fresh settled writer proof before restoration; only an owned MTK stage may await activation",
      }
    },
  }
  const returnStep: AssertionStep = {
    id: "day1-combined-return",
    kind: "assertion",
    instruction: "Independently verify all firmware, updater/stream idle and the selected app connection.",
    observe: async (c) => {
      expectedContext(c)
      const started = Date.now(),
        {result, evidence} = await runtime.collectReturn(c)
      requireThat(
        result.mode === "collect" &&
          result.fixtureStateChanged === false &&
          Date.parse(result.finishedAt) >= started - 1000 &&
          Date.parse(result.finishedAt) <= Date.now() + 1000 &&
          evidence.length > 0,
        "Return collector did not produce fresh combined evidence",
      )
      const targets: {[key: string]: unknown} = {
        "firmware.mtk": selected.profile.mtk.version,
        "firmware.asg.version": selected.profile.asg.versionCode,
        "firmware.asg.active-apk": selected.profile.asg.artifact.sha256,
        "firmware.bes.version": selected.profile.bes.version,
        "identity.cid": selected.fixture.cid.toLowerCase(),
        "identity.bluetooth": selected.fixture.bluetooth.toUpperCase(),
      }
      requireThat(
        Object.entries(targets).every(([id, expected]) =>
          result.firmwareAssertions.some((check) => check.id === id && same(check.expected, expected)),
        ),
        "Combined return collector used another profile or fixture",
      )
      const passed =
        result.returnObservationPassed === true &&
        result.appConnection === "observed-connected" &&
        result.streamStopped === true &&
        result.firmwareAssertions.length === 14 &&
        new Set(result.firmwareAssertions.map((check) => check.id)).size === 14 &&
        result.firmwareAssertions.every((check) => check.status === "passed") &&
        result.idleChecks.length > 0 &&
        result.idleChecks.every((check) => check.passed)
      return {
        passed,
        expected: selected.profile as unknown as Json,
        actual: result as unknown as Json,
        observedAt: result.finishedAt,
        source: "Existing combined return collector",
        evidence,
      }
    },
  }
  const routine: LifecycleRoutine = {
    id: "day1-ota",
    definitionDigest,
    preflight: [staticStep, ...steps.preflight, bindRecording],
    setup: [
      ...steps.beforeSetup,
      createDay1BesStep(selected.bes, runtime.bes),
      deferredStep(0),
      deferredStep(1),
      ...steps.beforeCustomer,
    ],
    test: [customer],
    finalAssertions: [finalCustomer],
    teardown: [restoreBarrier, ...steps.beforeRestore, ...restore, ...steps.afterRestore],
    returnVerification: [returnStep],
    evidence: [
      {
        id: "day1-recording-integrity",
        kind: "assertion",
        instruction: "Finalize and independently verify the actual claim-bound recording.",
        observe: async (c) => {
          expectedContext(c)
          return finalizeCiRecording({...runtime.recording.ci, ...(await runtime.recording.finish(c))})
        },
      },
    ],
  }
  const ids = Object.values(routine).flatMap((value) => (Array.isArray(value) ? value.map((step) => step.id) : []))
  requireThat(new Set(ids).size === ids.length, "Day-one hook step IDs must be unique")
  return {
    routine,
    inputs: adapterInputs,
    definitionDigest,
    /** Invoke only after intake writes its terminal result; never inside the lifecycle evidence phase. */
    exportCompleted: (outputDirectory: string) => exportCiRun({...runtime.recording.ci, outputDirectory}),
  }
}
