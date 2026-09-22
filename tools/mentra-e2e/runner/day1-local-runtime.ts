// Explicit reviewed local registration. No device, UI, network or lease work runs on import.
import {rename} from "node:fs/promises"
import {basename, dirname, join} from "node:path"
import {isDeepStrictEqual as same} from "node:util"
import {createDay1Routine, day1RoutineSourcePaths, type Day1RoutineRuntime} from "./day1-routine"
import {createDay1BesRuntime} from "./day1-bes-runtime"
import {createDay1FullOtaRuntime} from "./day1-full-ota-runtime"
import {createDay1MacAppStep, type Day1MacAppInputs} from "./day1-mac-app"
import {createMtkFullRestoreRuntime, type MtkRestoreRuntimeConfig} from "./mtk-full-restore-runtime"
import {createJanuaryHardwareReader, type JanuarySetupEvidence} from "./ota-january-identity"
import {createJanuaryPairVerifier} from "./ota-january-pairing"
import {createOtaRecording, type OtaRecordingFixture} from "./ota-recording"
import {readOtaHardware, type OtaFixture} from "./ota-hardware"
import {loadLegacyRoute, verifyPublishedLegacyManifests} from "./ota-legacy-route"
import {parseFirmwareProfile, type FirmwareProfile} from "./firmware-profile"
import {collectReturnObservation, PROBE_BYTES, PROBE_SHA, validateProbePath} from "./return-collector"
import {appObserver} from "./return-app-observer"
import {command, snapshot, bin, root, type Doctor} from "./driver"
import {acquireLock, Report} from "./report"
import {parseRoutineRequest, sha256, type LocalRoutineRegistration, type RegisteredRoutineContext} from "./ci-request"
import type {AssertionStep, Json, LifecycleContext} from "./lifecycle"
import type {ChapterPhase} from "./recorded-evidence"
import type {Day1BesInputs} from "./day1-bes"
import type {Day1RoutineInputs} from "./day1-routine"
import {Evidence, absolute, file, hash, json, reference, requireThat, type Ref} from "./day1-local-io"
import {createWifiAdbSteps, type WifiAdbInputs} from "./wifi-adb"
import {createDay1StatusProbeStep, DAY1_STATUS_PROBE_REMOTE} from "./day1-status-probe"
import {normalizeFirmware} from "./ota-state"
import {createOtaCustomerStep} from "./ota-customer-step"
import type {MtkRestoreObservation} from "./mtk-full-restore"

export interface LocalConfig {
  schemaVersion: 1
  repositoryRoot: string
  stateDirectory: string
  fixtureDirectory: string
  fixtureID: string
  request: Ref
  trust: Ref
  selection: Ref
  runtimeInputs: Ref
  admission: Ref
}
export interface RuntimeInputs {
  sourceProbeRemote: string
  leasePath: string
  fixture: {serial: string; cid: string; bluetooth: string; returnUsb: string}
  bes: Day1BesInputs
  january: Day1RoutineInputs["january"]
  app: Omit<Day1MacAppInputs, "id" | "phase" | "action" | "manifest" | "leasePath">
  restore: Omit<Day1RoutineInputs["restore"], "fixture" | "profile" | "artifact">
  restoreRuntime: MtkRestoreRuntimeConfig & {setupBaseline?: {mtkVersion: string; besVersion: string}}
  // Explicit owned transport steps are supplied by the sibling normal-product adapter.
  wifi: WifiAdbInputs
}
type Prepared = Awaited<ReturnType<typeof import("./ci-selection").resolveDay1CiSelection>>["selection"]
const at = () => new Date().toISOString()
const proof = (passed: boolean, actual: unknown, evidence: string[], source: string) => ({
  passed,
  actual: actual as Json,
  expected: "Exact selected identity and fresh independent proof",
  observedAt: at(),
  evidence,
  source,
})

/** File-only resolution. No imported request value becomes a command/module name. */
export async function loadLocalConfig(ref: Ref) {
  const cfg = await json<LocalConfig>(ref, true)
  requireThat(cfg.schemaVersion === 1 && cfg.repositoryRoot === root, "Local config must select this trusted checkout")
  for (const path of [cfg.stateDirectory, cfg.fixtureDirectory]) absolute(path)
  await file(cfg.trust)
  const request = parseRoutineRequest(await file(cfg.request))
  requireThat(request.status === "ready" && request.selection, "A real ready CI selection is required")
  const selected = await json<Prepared>(cfg.selection, true),
    host = await json<RuntimeInputs>(cfg.runtimeInputs, true)
  requireThat(
    selected.kind === "day1-ci-selection" &&
      selected.requestId === request.requestId &&
      selected.requestSha256 === sha256(Buffer.from(JSON.stringify(request))),
    "Prepared selection differs from the exact request",
  )
  requireThat(
    Object.entries(request.selection.app).every(([key, value]) => selected.app.verifiedCiBuild[key] === value) &&
      selected.otaManifest.sha256 === request.selection.otaManifest.sha256 &&
      selected.otaManifest.url === request.selection.otaManifest.url,
    "Prepared artifact differs from CI",
  )
  const manifestBytes = await file(selected.otaManifest),
    profile = parseFirmwareProfile(manifestBytes, selected.otaManifest)
  requireThat(same(profile, selected.returnProfile), "Prepared return profile changed")
  await file(selected.app.manifest)
  await file(selected.legacyRoute)
  requireThat(
    host.app.driver.path === bin &&
      basename(host.leasePath) === "com.mentra.mentra.lock" &&
      host.leasePath === host.restoreRuntime.leasePath,
    "Use the selected native harness and common lease",
  )
  validateProbePath(host.sourceProbeRemote)
  requireThat(
    host.restore.probe.remote === DAY1_STATUS_PROBE_REMOTE,
    "Return uses the same SHA-owned probe staged by January recovery",
  )
  requireThat(
    same(host.wifi.adb, host.restoreRuntime.adb) &&
      host.wifi.leasePath === host.leasePath &&
      host.wifi.fixture.usb === host.fixture.returnUsb &&
      host.wifi.fixture.serial === host.fixture.serial &&
      host.wifi.fixture.cid === host.fixture.cid &&
      host.wifi.fixture.bluetooth === host.fixture.bluetooth,
    "Transport preparation must bind the same tools, lease and full fixture",
  )
  const bes = await json(host.bes.config, true),
    january = await json(host.january.template, true)
  requireThat(
    bes.lease.path === host.leasePath &&
      january.lease.path === host.leasePath &&
      same(bes.tools.adb, host.restoreRuntime.adb),
    "Firmware adapters must use the same lease and pinned ADB",
  )
  requireThat(
    bes.fixture.cid === host.fixture.cid &&
      bes.fixture.mac === host.fixture.bluetooth &&
      bes.fixture.serial_aliases.includes(host.fixture.serial) &&
      bes.fixture.transport.kind === "network" &&
      bes.fixture.transport.address === host.wifi.fixture.wifiEndpoint,
    "BES source configuration differs from the transport fixture",
  )
  requireThat(
    january.profileId === "january-20260113-powerwash-asg27" &&
      january.profileSha256 === "7f17e63f0ed5bd66f6a9e11940b82f6eeb8209fa88b558821ced0bef063123f6" &&
      bes.target.version === "17.26.1.13",
    "Only the qualified January setup profile is supported",
  )
  const setupBaseline = {mtkVersion: "MentraLive_20260113", besVersion: bes.target.version as string}
  requireThat(
    host.restoreRuntime.setupBaseline === undefined || same(host.restoreRuntime.setupBaseline, setupBaseline),
    "Setup baseline differs from pinned January inputs",
  )
  host.restoreRuntime = {...host.restoreRuntime, setupBaseline}
  requireThat(host.restoreRuntime.artifactVerification, "Actual full-payload verification record is required")
  const verified = await json(host.restoreRuntime.artifactVerification, true)
  requireThat(
    verified.fullPayload === true &&
      verified.powerwash === false &&
      verified.payloadSignatureVerification === "passed" &&
      verified.targetPartitionVerification === "passed" &&
      verified.otaSha256 === profile.mtk.artifact.sha256 &&
      verified.otaBytes === profile.mtk.artifact.size &&
      verified.manifestSha256 === profile.manifest.sha256 &&
      verified.targetVersion === profile.mtk.version,
    "Full-payload verification is missing or belongs to another selection",
  )
  const legacy = await loadLegacyRoute(await json(selected.legacyRoute), {
    buildSha: String(selected.app.verifiedCiBuild.buildSha),
    executableSha256: String(selected.app.verifiedCiBuild.executableSha256),
    manifestSha256: selected.otaManifest.sha256,
    manifestUrl: selected.otaManifest.url,
    beforeFirmware: "20260113",
    beforeAsg: 27,
    targetFirmware: profile.mtk.version,
    targetAsg: profile.asg.versionCode,
    targetPatches: JSON.parse(manifestBytes.toString()).mtk_patches,
  })
  return {cfg, request, selected, host, profile, manifestBytes, legacy}
}

export async function createLocalRegistration(ref: Ref) {
  const resolved = await loadLocalConfig(ref),
    {cfg, request, selected, host, profile, manifestBytes, legacy} = resolved
  const base = join(cfg.stateDirectory, "runs", request.requestId)
  const firmwareFixture = {
    usb: host.fixture.returnUsb,
    cid: host.fixture.cid,
    bluetooth: host.fixture.bluetooth,
    serials: [host.fixture.serial],
  }
  const input: Day1RoutineInputs = {
    appManifest: selected.app.manifest,
    manifest: selected.otaManifest,
    profile,
    fixture: firmwareFixture,
    returnProfileDigest: hash(Buffer.from(JSON.stringify(profile))),
    sources: await Promise.all(
      [
        ...day1RoutineSourcePaths,
        join(import.meta.dir, "day1-local-io.ts"),
        join(import.meta.dir, "wifi-adb.ts"),
        join(import.meta.dir, "day1-status-probe.ts"),
        join(import.meta.dir, "../day1-local.ts"),
        ...[
          "driver.ts",
          "report.ts",
          "video.ts",
          "ota-hardware.ts",
          "ota-state.ts",
          "ota-legacy-route.ts",
          "ota-january-identity.ts",
          "ota-january-pairing.ts",
          "ci-request.ts",
          "ci-selection.ts",
        ].map((name) => join(import.meta.dir, name)),
        cfg.runtimeInputs.path,
      ].map(reference),
    ),
    runtimeSource: await reference(import.meta.path),
    bes: host.bes,
    january: host.january,
    restore: {...host.restore, profile, fixture: firmwareFixture, artifact: selected.returnArtifacts.mtk},
  }
  let finalComposition: ReturnType<typeof createDay1Routine> | undefined
  const make = async (context?: RegisteredRoutineContext) => {
    const ci = {
      claim: context
        ? await reference(context.claimPath)
        : {path: join(cfg.stateDirectory, "claims", `${request.requestId}.json`), sha256: "0".repeat(64)},
      trust: cfg.trust,
    }
    let report: Report | undefined, recording: Awaited<ReturnType<typeof createOtaRecording>> | undefined
    let baseline: JanuarySetupEvidence | undefined,
      customerFixture: OtaRecordingFixture | undefined,
      reader: Awaited<ReturnType<typeof createJanuaryHardwareReader>> | undefined
    let binding: Awaited<ReturnType<typeof import("./ci-run-exporter").ciRecordingBinding>> | undefined
    let restoreRecording: Awaited<ReturnType<typeof createOtaRecording>> | undefined
    let restoreFixture: OtaRecordingFixture | undefined
    let stopped = false,
      parked = false,
      seq = 0
    const phases: Record<string, ChapterPhase> = {}
    const notes = async (c: LifecycleContext, label: string) =>
      Evidence.create(c.runDirectory, label, host.restoreRuntime.adb, host.leasePath)
    const restore = createMtkFullRestoreRuntime(input.restore, host.restoreRuntime)
    // The enrollment probe survives until POWERWASH. Do not require the new global
    // probe before its explicit owned setup step has installed it.
    const readSource = async (c: LifecycleContext) => {
      const rec = await notes(c, "source-idle"),
        fixture = {...firmwareFixture, serial: host.fixture.serial}
      const profiles = [profile, ...host.restoreRuntime.sourceProfiles]
      const first = await readOtaHardware(
        fixture,
        profiles.map((p) => p.mtk.version),
        profiles.map((p) => p.asg.versionCode),
        false,
        (argv) => rec.run(argv),
      )
      const matches = profiles.filter(
        (p) =>
          normalizeFirmware(p.mtk.version) === normalizeFirmware(first.firmware) &&
          p.asg.versionCode === first.asgVersion,
      )
      requireThat(
        matches.length > 0 && matches.every((p) => same(p.asg, matches[0].asg) && same(p.bes, matches[0].bes)),
        "Ambiguous source profile",
      )
      const result = await collectReturnObservation({
        profile: matches[0],
        fixture,
        probe: {path: host.sourceProbeRemote, sha256: PROBE_SHA, size: PROBE_BYTES},
        recorder: rec,
      })
      const closing = await readOtaHardware(fixture, [first.firmware], [first.asgVersion], false, (argv) =>
        rec.run(argv),
      )
      requireThat(
        result.adbQualified && closing.bootId === first.bootId && closing.transport === first.transport,
        "Source components and all writers must be independently idle on the same boot",
      )
      const {shell, ...identity} = closing
      return {identity, actual: result, evidence: [join(rec.output, "result.json")]}
    }
    const app = (id: string, action: "stop" | "launch", phase: "setup" | "teardown") =>
      createDay1MacAppStep({...host.app, id, action, phase, manifest: selected.app.manifest, leasePath: host.leasePath})
    const observe = (id: string, read: (c: LifecycleContext) => Promise<any>): AssertionStep => ({
      id,
      kind: "assertion",
      instruction: id.replaceAll("-", " "),
      observe: read,
    })
    const frame = async (phase: ChapterPhase, instruction: string, passed: boolean) => {
      requireThat(report?.video && !parked, "Recording must observe the current selected app")
      const id = `CHECK-${++seq}`,
        mark = await report.video.mark()
      phases[id] = phase
      const row = await report.record(
        {
          id,
          instruction,
          expected: instruction,
          status: passed ? "passed" : "failed",
          durationMs: 0,
          videoStart: mark,
          videoEnd: mark,
        },
        await snapshot(),
      )
      requireThat(row.status === (passed ? "passed" : "failed"), "Recorded observation failed")
    }
    const startCustomer = observe("start-selected-customer-capture", async (c) => {
      requireThat(binding, "CI report binding missing")
      const op = c.operations.find((op) => op.stepID === "day1-full-ota-stage"),
        activation = c.operations.find((op) => op.stepID === "day1-full-ota-activate")
      requireThat(
        op?.reconciliation?.status === "satisfied" && activation?.reconciliation?.status === "satisfied",
        "Owned January setup must be complete",
      )
      const config = await reference(join(c.runDirectory, "day1-january-inputs/config.json"))
      baseline = {
        config,
        owner: op.operationID,
        activationResult: await reference(join(c.runDirectory, "day1-full-ota/activation/result.json")),
        recoveryAfter: await reference(join(c.runDirectory, "day1-full-ota/activation/recovery/after.json")),
      }
      const after = await json(baseline.recoveryAfter, true)
      customerFixture = {
        serial: host.fixture.serial,
        cid: host.fixture.cid,
        bluetooth: host.fixture.bluetooth,
        wifiEndpoint: after.freshBleBridge.endpoint,
        before: {firmware: "MentraLive_20260113", asgVersion: 27, bootId: after.boot, slot: after.slot},
      }
      const rec = await notes(c, "customer-observer")
      reader = await createJanuaryHardwareReader(
        {baseline, fixture: customerFixture, legacy, returnUsb: host.fixture.returnUsb},
        (argv) => rec.run(argv),
      )
      report = new Report("day1-ota", [])
      await report.start(
        await command<Doctor>({op: "doctor"}),
        JSON.stringify(customerFixture),
        selected.app.manifest.path,
      )
      const contained = join(c.runDirectory, "customer-report")
      await rename(report.directory, contained)
      report.directory = contained
      Object.assign(report.metadata, {
        executionMode: "ci-registered",
        modelCalls: 0,
        ciLifecycle: binding,
        admissionScope: "authorized lab qualification; full routine outcome is not known yet",
        recordingScope:
          "Customer flow and final return; setup is recorded in lifecycle/adapter journals, not fabricated window video",
      })
      recording = await createOtaRecording(
        report,
        {
          fixture: customerFixture,
          build: {otaManifestUrl: selected.otaManifest.url},
          manifestBytes,
          manifestUrl: selected.otaManifest.url,
          legacy,
          resume: false,
        },
        {readHardware: reader.readHardware, run: (argv) => rec.run(argv)},
      )
      recording.actions.verifyAppPair = createJanuaryPairVerifier(
        recording.actions,
        customerFixture,
        baseline.recoveryAfter,
      )
      await report.startVideo()
      return proof(
        true,
        {report: contained, originalBoot: reader.originalBoot},
        [join(contained, "run.json"), baseline.recoveryAfter.path],
        "Native capture after selected app launch",
      )
    })
    const collect = async (c: LifecycleContext, withApp: boolean, label: string) => {
      const rec = await notes(c, label)
      const result = await collectReturnObservation(
        {
          profile,
          fixture: {...firmwareFixture, serial: host.fixture.serial},
          probe: {path: host.restore.probe.remote, sha256: PROBE_SHA, size: PROBE_BYTES},
          recorder: rec,
        },
        withApp
          ? appObserver(
              {buildManifest: selected.app.manifest.path, buildManifestSha256: selected.app.manifest.sha256},
              {
                captureScreenshot: (path) => {
                  requireThat(report?.video && !parked, "Active owned recording required")
                  return report.video.screenshot(path)
                },
              },
            )
          : undefined,
      )
      return {result, evidence: [join(rec.output, "result.json")]}
    }
    const sourceSafety = {
      assertSafeToChange: async (
        c: LifecycleContext,
        current: {bootId: string; cid: string; serial: string; bluetooth: string},
      ) => {
        const observed = await readSource(c)
        requireThat(
          observed.identity.bootId === current.bootId &&
            observed.identity.cid === current.cid &&
            observed.identity.serial === current.serial &&
            observed.identity.bluetooth === current.bluetooth,
          "Preparation requires fresh same-fixture all-writer idle proof",
        )
        return {evidence: observed.evidence}
      },
    }
    const wifi = createWifiAdbSteps(host.wifi, {
      assertSafeToChange: async (c, current) => {
        if (!c.operations.some((op) => op.stepID === "day1-full-ota-stage"))
          return sourceSafety.assertSafeToChange(c, current)
        const observed = await restore.read(c)
        requireThat(
          observed.writersIdle &&
            observed.engineStatus === "UPDATE_STATUS_IDLE" &&
            observed.identity.bootId === current.bootId &&
            observed.identity.cid === current.cid &&
            observed.identity.serial === current.serial &&
            observed.identity.bluetooth === current.bluetooth,
          "Preference restoration requires fresh same-fixture all-writer idle proof",
        )
        return {evidence: observed.evidence}
      },
    })
    const probe = createDay1StatusProbeStep(
      {
        id: "stage-owned-status-probe",
        adb: host.restoreRuntime.adb,
        probe: {path: host.restore.probe.path, sha256: PROBE_SHA, size: PROBE_BYTES},
        leasePath: host.leasePath,
        fixture: {
          usb: host.fixture.returnUsb,
          serial: host.fixture.serial,
          cid: host.fixture.cid,
          bluetooth: host.fixture.bluetooth,
        },
        allowed: host.wifi.allowed,
      },
      sourceSafety,
    )
    const verifySelectedManifest = async () => {
      const response = await fetch(selected.otaManifest.url, {signal: AbortSignal.timeout(20000)})
      requireThat(
        response.ok && Buffer.from(await response.arrayBuffer()).equals(manifestBytes),
        "Published selected OTA manifest changed",
      )
    }
    const restoreComponents = createOtaCustomerStep(
      {
        prepare: async (c) => {
          const current = await restore.read(c)
          restoreFixture = productRestoreBaseline(current, {...firmwareFixture, serial: host.fixture.serial}, profile)
          return proof(
            true,
            current.actual,
            current.evidence,
            "Fresh modern baseline for the separate product restoration",
          )
        },
        recording: async (c) => {
          requireThat(
            report?.video && !parked && restoreFixture,
            "Product restoration needs the same active recording and fresh modern baseline",
          )
          const current = await restore.read(c)
          requireThat(
            current.writersIdle &&
              current.engineStatus === "UPDATE_STATUS_IDLE" &&
              current.identity.bootId === restoreFixture.before.bootId &&
              current.identity.slot === restoreFixture.before.slot,
            "Modern baseline changed before product restoration",
          )
          const rec = await notes(c, "component-restore")
          restoreRecording = await createOtaRecording(
            report,
            {
              fixture: restoreFixture,
              build: {otaManifestUrl: selected.otaManifest.url},
              manifestBytes,
              manifestUrl: selected.otaManifest.url,
              resume: false,
              session: "restore",
            },
            {
              readHardware: (...args) => readOtaHardware(args[0], args[1], args[2], args[3], (argv) => rec.run(argv)),
              run: (argv) => rec.run(argv),
              spawnLogger: (transport, path) =>
                Bun.spawn([host.restoreRuntime.adb.path, "-t", transport, "logcat", "-v", "epoch", "-T", "1"], {
                  stdout: Bun.file(path),
                  stderr: Bun.file(path + ".stderr"),
                }),
            },
          )
          restoreRecording.actions.verifyPublishedManifests = async () => {
            await verifySelectedManifest()
            const idle = await restore.read(c)
            requireThat(
              idle.writersIdle && idle.engineStatus === "UPDATE_STATUS_IDLE",
              "Writers are not idle before the next owned restoration pass",
            )
          }
          return {
            selection: {
              install: true,
              resume: false,
              minutes: 20,
              before: restoreFixture.before,
              target: {asgVersion: profile.asg.versionCode, firmware: profile.mtk.version, bes: profile.bes.version},
            },
            actions: restoreRecording.actions,
            metadata: restoreRecording.sessionMetadata,
          }
        },
        verifyTarget: async (c) => {
          const value = await collect(c, true, "restored-components")
          await frame(
            "teardown",
            "Verify the independent product restoration reached all selected targets.",
            value.result.returnObservationPassed,
          )
          return proof(
            value.result.returnObservationPassed,
            value.result,
            value.evidence,
            "Selected target collector after separate product restoration",
          )
        },
        idle: (c, intent) => runtime.customer.idle(c, intent),
        recordFailure: async (error, c) => {
          const rec = await notes(c, "component-restore-failure")
          await rec.json("failure.json", {
            error: String(error),
            phase: "teardown",
            originalCustomerVerdictUnchanged: true,
            automaticResend: false,
          })
        },
      },
      {id: "restore-selected-components", phase: "teardown"},
    )
    const runtime: Day1RoutineRuntime = {
      bes: createDay1BesRuntime(input.bes),
      january: (inputs) => createDay1FullOtaRuntime(inputs, {stageMissingProbe: true}),
      restore,
      preflight: [
        observe("verify-live-selected-app-and-fixture", async (c) => {
          const doc = await command<Doctor>({op: "doctor"})
          requireThat(doc.frontmostBundleId !== "com.apple.loginwindow", "Unlock the Mac before this lab run")
          const selectedApp = await app("preflight-selected-app", "launch", "setup").reconcile(c)
          requireThat(
            selectedApp.status === "satisfied",
            "The exact selected CI app must already be installed and running",
          )
          const current = await readSource(c)
          await verifyPublishedLegacyManifests(legacy.route.manifests)
          const response = await fetch(selected.otaManifest.url, {signal: AbortSignal.timeout(20000)})
          requireThat(
            response.ok && Buffer.from(await response.arrayBuffer()).equals(manifestBytes),
            "Published selected OTA manifest changed",
          )
          return proof(true, current.actual, current.evidence, "Exact selected app and fresh source fixture")
        }),
      ],
      beforeSetup: [
        probe,
        wifi.enable,
        app("stop-app-before-january", "stop", "setup"),
        observe("refresh-source-before-bes", async (c) => {
          const current = await readSource(c)
          return proof(
            true,
            current.actual,
            current.evidence,
            "Fresh normal ASG version/status query before BES; archived source proof remains only the anchor",
          )
        }),
      ],
      beforeCustomer: [app("launch-app-before-customer", "launch", "setup"), startCustomer],
      beforeRestore: [
        observe("park-customer-capture", async () => {
          await recording?.close()
          if (report?.video) {
            await report.video.park()
            parked = true
          }
          return proof(
            true,
            {parked},
            report ? [join(report.directory, "run.json")] : [ci.claim.path],
            "Owned recorder lifecycle",
          )
        }),
        app("stop-app-before-restore", "stop", "teardown"),
      ],
      afterRestore: [
        app("launch-app-after-restore", "launch", "teardown"),
        observe("reattach-return-capture", async () => {
          if (report?.video && parked) {
            await report.video.reattach()
            parked = false
          }
          return proof(
            true,
            {parked},
            report ? [join(report.directory, "run.json")] : [ci.claim.path],
            "Same owned recorder after selected app launch",
          )
        }),
        restoreComponents,
        wifi.restore,
      ],
      customer: {
        prepare: async (c) => {
          requireThat(reader && customerFixture && baseline, "Recorded January setup binding missing")
          const rec = await notes(c, "prepared-january"),
            actual = await reader.readHardware(customerFixture, ["MentraLive_20260113"], [27], false)
          const {shell, ...identity} = actual
          const evidence = await rec.json("identity.json", identity)
          return proof(
            actual.bootId === customerFixture.before.bootId && actual.slot === customerFixture.before.slot,
            identity,
            [evidence, baseline.recoveryAfter.path],
            "Original January boot and owned activation",
          )
        },
        recording: async () => {
          requireThat(recording && report && customerFixture, "Customer capture has not started")
          return {
            selection: {
              install: true,
              resume: false,
              minutes: 35,
              before: customerFixture.before,
              target: {asgVersion: profile.asg.versionCode, firmware: profile.mtk.version, bes: profile.bes.version},
            },
            actions: recording.actions,
            metadata: report.metadata,
          }
        },
        verifyTarget: async (c) => {
          const value = await collect(c, true, "customer-target")
          await frame(
            "verify",
            "Verify the customer reached all selected firmware targets and paired home.",
            value.result.returnObservationPassed,
          )
          return proof(
            value.result.returnObservationPassed,
            value.result,
            value.evidence,
            "Independent customer target and app collector",
          )
        },
        idle: async (c) => {
          try {
            const value = await restore.read(c)
            return {
              ...value,
              identity: value.identity as unknown as Json,
              status: value.writersIdle && value.engineStatus === "UPDATE_STATUS_IDLE" ? "settled" : "unknown",
            }
          } catch (error) {
            const rec = await notes(c, "unavailable-idle"),
              evidence = await rec.json("quarantine.json", {reason: String(error), restorationAuthorized: false})
            return {
              ...proof(
                false,
                {reason: "No independently verified modern writer state; legacy ambiguity quarantined"},
                [evidence],
                "Fresh failed idle observation",
              ),
              status: "unknown",
            }
          }
        },
        recordFailure: async (error, c) => {
          const rec = await notes(c, "customer-failure")
          await rec.json("failure.json", {error: String(error), automaticResend: false})
        },
      },
      collectReturn: async (c) => {
        const result = await collect(c, true, "final-return")
        await frame(
          "teardown",
          "Verify exact firmware, stopped writers and streams, and selected paired home after teardown.",
          result.result.returnObservationPassed,
        )
        return result
      },
      recording: {
        ci,
        bind: async (_c, value) => {
          binding = value
        },
        finish: async (c) => {
          requireThat(report, "No customer recording was started; evidence remains incomplete")
          await recording?.close()
          await restoreRecording?.close()
          const failed = c.operations.some((op) => op.dispatchError || (op.dispatch as any)?.failed === true)
          if (!stopped) {
            await report.finish(
              failed ? "failed" : "passed",
              "Claim-bound lab qualification. Lifecycle outcomes independently determine test, teardown and fixture status.",
            )
            stopped = true
          }
          for (const step of report.results)
            phases[step.id] ??= step.id.startsWith("RESTORE-OTA-") ? "teardown" : "test"
          return {
            reportDirectory: report.directory,
            harnessDirectory: join(cfg.repositoryRoot, "tools/mentra-e2e"),
            phaseByStep: phases,
          }
        },
      },
    }
    const composition = createDay1Routine(input, runtime)
    return {
      composition,
      cleanup: async () => {
        await recording?.close()
        await restoreRecording?.close()
        if (report && !stopped) {
          await report.finish("failed", "Interrupted owned lifecycle; original outcome preserved")
          stopped = true
        }
      },
    }
  }
  const template = await make()
  const verifyAdmission = () =>
    verifyLocalAdmission(cfg, {
      definitionDigest: template.composition.definitionDigest,
      returnProfileDigest: input.returnProfileDigest,
      requestSha256: sha256(Buffer.from(JSON.stringify(request))),
      sourceProfileDigests: [profile, ...host.restoreRuntime.sourceProfiles].map((value) =>
        hash(Buffer.from(JSON.stringify(value))),
      ),
    })
  const registration: LocalRoutineRegistration = {
    verify: async (actual) => {
      requireThat(same(actual, request), "Different CI request supplied")
      return verifyAdmission()
    },
    prepare: async (context) => {
      requireThat(context.runDirectory === base, "Unexpected worker run directory")
      const current = await make(context)
      finalComposition = current.composition
      return {
        routine: current.composition.routine,
        inputs: current.composition.inputs,
        acquireLease: async () => {
          const release = await acquireLock(dirname(host.leasePath))
          return async () => {
            try {
              await current.cleanup()
            } finally {
              await release()
            }
          }
        },
      }
    },
  }
  return {
    resolved,
    registration,
    definitionDigest: template.composition.definitionDigest,
    returnProfileDigest: input.returnProfileDigest,
    check: verifyAdmission,
    exportCompleted: async (output: string) => {
      requireThat(finalComposition, "This process did not consume a lifecycle")
      return finalComposition.exportCompleted(output)
    },
  }
}

/** File-only admission. This authenticates an explicit lab approval and a real
 * completed fixture return; it never treats that packet as a whole-routine pass. */
export async function verifyLocalAdmission(
  cfg: LocalConfig,
  binding: {
    definitionDigest: string
    returnProfileDigest: string
    requestSha256: string
    sourceProfileDigests: string[]
  },
) {
  const packet = await json(cfg.admission, true)
  requireThat(
    packet.schemaVersion === 1 &&
      packet.kind === "authorized-lab-qualification" &&
      packet.fullRoutinePassed === false &&
      packet.routineId === "day1-ota" &&
      packet.definitionDigest === binding.definitionDigest &&
      packet.fixtureID === cfg.fixtureID &&
      packet.returnProfileDigest === binding.returnProfileDigest &&
      packet.requestSha256 === binding.requestSha256,
    "Missing reviewed lab-admission packet for this exact definition/request/fixture",
  )
  const required = ["source-validation", "firmware-artifacts", "native-components", "selected-full-ota"]
  requireThat(
    Array.isArray(packet.evidence) &&
      required.every((kind) => packet.evidence.some((item: any) => item.kind === kind)) &&
      packet.unsupportedLegacyState === "quarantine-no-restoration" &&
      packet.restoreScope === "selected-mtk-and-gated-product-ota",
    "Admission must bind reviewed evidence and explicit restoration limits",
  )
  for (const ref of packet.evidence) await file(ref, 8 * 1024 * 1024)
  const current = await json(await reference(join(absolute(cfg.fixtureDirectory), "fixture.json")), true)
  requireThat(
    current.schemaVersion === 1 &&
      current.fixtureID === cfg.fixtureID &&
      current.status === "ready" &&
      current.returnProfileDigest === packet.enrolledSourceProfileDigest &&
      binding.sourceProfileDigests.includes(packet.enrolledSourceProfileDigest) &&
      current.lastVerification &&
      current.runDirectory === current.lastVerification.runDirectory,
    "The fixture must be independently enrolled and ready",
  )
  const directory = absolute(current.lastVerification.runDirectory)
  const descriptor = await json(await reference(join(directory, "run.json")), true)
  requireThat(
    descriptor.schemaVersion === 1 &&
      descriptor.selection.runID === current.runID &&
      descriptor.selection.fixtureID === cfg.fixtureID &&
      descriptor.selection.returnProfileDigest === packet.enrolledSourceProfileDigest,
    "Original enrollment selection differs from the ready fixture",
  )
  const result = await json(await reference(join(directory, "result.json")), true)
  const log = await file(await reference(join(directory, "events.jsonl")), 8 * 1024 * 1024, true)
  requireThat(log.length > 0 && log.at(-1) === 10, "Incomplete original fixture journal")
  const rows = log
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    last = rows.at(-1)
  requireThat(
    rows.length > 0 &&
      rows.every((row, index) => row.sequence === index + 1) &&
      last.type === "run-finished" &&
      last.sequence === current.lastVerification.sequence &&
      last.state.mode === "complete" &&
      same(last.details, result) &&
      result.runID === current.runID &&
      result.fixture === "ready" &&
      result.returnVerification === "passed" &&
      result.teardown === "passed" &&
      result.evidence === "passed",
    "Ready fixture lacks its original completed return-verification journal",
  )
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {cwd: cfg.repositoryRoot, stdout: "pipe", stderr: "pipe"})
  const revision = git.stdout.toString().trim()
  requireThat(git.exitCode === 0 && packet.harnessRevision === revision, "Admission harness revision differs")
  return {
    routineId: "day1-ota" as const,
    requestSha256: packet.requestSha256,
    harnessRevision: revision,
    definitionDigest: binding.definitionDigest,
    qualificationDigest: cfg.admission.sha256,
    fixtureID: cfg.fixtureID,
    fixtureDirectory: cfg.fixtureDirectory,
    returnProfileDigest: binding.returnProfileDigest,
  }
}

/** Eligibility only: the concrete restore reader already authenticates fresh
 * identity, active APK and writer state. This does not certify a target pass. */
export function productRestoreBaseline(
  current: MtkRestoreObservation,
  fixture: OtaFixture,
  profile: FirmwareProfile,
): OtaRecordingFixture {
  requireThat(
    current.writersIdle &&
      current.engineStatus === "UPDATE_STATUS_IDLE" &&
      normalizeFirmware(current.identity.firmware) === normalizeFirmware(profile.mtk.version),
    "Product restoration requires selected MTK and independently idle modern writers",
  )
  requireThat(
    current.identity.cid === fixture.cid &&
      current.identity.serial === fixture.serial &&
      current.identity.bluetooth === fixture.bluetooth,
    "Product restoration fixture changed",
  )
  const observed = (current.actual as any).observation
  requireThat(
    /^\d+(?:\.\d+){3}$/.test(observed.bes.version) &&
      Number.isSafeInteger(observed.asgVersion) &&
      observed.asgVersion > 37,
    "Invalid modern source version",
  )
  const version = String(observed.bes.version).split(".").map(Number),
    target = profile.bes.version.split(".").map(Number)
  requireThat(version.every(Number.isSafeInteger), "Invalid observed BES version")
  const difference = version.findIndex((value, index) => value !== target[index])
  requireThat(
    (difference < 0 || version[difference] < target[difference]) && observed.asgVersion <= profile.asg.versionCode,
    "Product restoration cannot downgrade newer BES or ASG",
  )
  return {
    ...fixture,
    before: {
      firmware: current.identity.firmware,
      asgVersion: observed.asgVersion,
      bootId: current.identity.bootId,
      slot: current.identity.slot,
    },
  }
}
