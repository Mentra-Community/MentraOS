import {afterEach, describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {basename, dirname, join, relative, resolve} from "node:path"
import {testRunSchema} from "../../../cloud-v2/packages/core/src/types/test-run.types"
import {
  consumeRoutineRequest,
  parseRoutineRequest,
  REQUEST_REPOSITORY,
  REQUEST_WORKFLOW,
  sha256,
  type RequestTrust,
  type RequestEvidence,
  type LocalRoutineRegistration,
} from "./ci-request"
import {ciRecordingBinding, exportCiRun, finalizeCiRecording} from "./ci-run-exporter"
import {assertFirmwareState, type FirmwareObservation, type FirmwareProfile} from "./firmware-profile"
import {
  recoverLifecycle,
  type AssertionStep,
  type Json,
  type LifecycleContext,
  type LifecycleOptions,
  type LifecycleStep,
} from "./lifecycle"
import {day1ReturnSources} from "./day1-local-runtime"
import {collectReturnObservation} from "./return-collector"
import {simulatedReturnCollection} from "./return-collector.test-support"
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, {recursive: true, force: true})
})
const head = "a".repeat(40),
  base = "b".repeat(40),
  source = "c".repeat(40),
  hash = "d".repeat(64)
const json = (value: unknown) => Buffer.from(JSON.stringify(value))
function fixture() {
  const request = parseRoutineRequest(
    json({
      schemaVersion: 1,
      kind: "mentra-routine-request",
      requestId: "routine-200-1-4136-day1-ota",
      createdAt: "2026-09-21T10:10:00Z",
      status: "no-artifact",
      reason: "Mac build has not published",
      trigger: {
        kind: "pull_request",
        repository: REQUEST_REPOSITORY,
        workflow: REQUEST_WORKFLOW,
        runId: 200,
        runAttempt: 1,
        ref: "refs/pull/4136/merge",
        sha: source,
        workflowSha: source,
        workflowRef: `${REQUEST_REPOSITORY}/${REQUEST_WORKFLOW}@refs/pull/4136/merge`,
        actor: "tester",
      },
      pullRequest: {
        number: 4136,
        url: `https://github.com/${REQUEST_REPOSITORY}/pull/4136`,
        headSha: head,
        baseSha: base,
        headRepository: REQUEST_REPOSITORY,
        baseRef: "dev",
      },
      routine: {id: "day1-ota", reason: "Explicit routine:day1-ota PR label", harnessRevision: source},
      selection: null,
      attempts: [],
    }),
  )
  const trust: RequestTrust = {
    schemaVersion: 1,
    repository: REQUEST_REPOSITORY,
    entries: [{kind: "pull_request", pr: 4136, headSha: head, baseSha: base, sourceSha: source, workflowSha: source}],
  }
  const evidence: RequestEvidence = {
    run: {
      id: 200,
      run_attempt: 1,
      event: "pull_request",
      path: REQUEST_WORKFLOW,
      head_sha: head,
      head_branch: "codex/day1-ota",
      status: "completed",
      conclusion: "success",
      repository: {full_name: REQUEST_REPOSITORY},
      head_repository: {full_name: REQUEST_REPOSITORY},
    },
    artifact: {
      id: 300,
      name: "mentra-routine-request-200-1",
      size_in_bytes: 500,
      digest: `sha256:${hash}`,
      expired: false,
      workflow_run: {id: 200, head_sha: head},
    },
    archiveSha256: hash,
    sourceCommit: {sha: source, parents: [{sha: base}, {sha: head}]},
    currentBaseRef: {ref: "refs/heads/dev", object: {type: "commit", sha: base}},
    currentPr: {
      number: 4136,
      state: "open",
      head: {sha: head, ref: "codex/day1-ota", repo: {full_name: REQUEST_REPOSITORY}},
      base: {sha: base, ref: "dev"},
      labels: [{name: "routine:day1-ota"}],
    },
  }
  return {request, trust, evidence}
}
function ready() {
  const f = fixture()
  const cdn = `https://artifactscdn.mentraglass.com/${REQUEST_REPOSITORY}/releases/pr-builds/`
  const archiveName = `mentra-ios-mac-pr-4136-${head}-100-1.zip`
  const ota = `${cdn}ota-pr-4136-${head}.json`
  f.request.status = "ready"
  f.request.selection = {
    platform: "ios-on-mac",
    producer: {
      workflow: ".github/workflows/mentra-app-ios-build.yml",
      runId: 100,
      buildAttempt: 1,
      publicationAttempt: 2,
      url: `https://github.com/${REQUEST_REPOSITORY}/actions/runs/100`,
    },
    receipt: {url: `${cdn}mentra-ios-pr-4136-${head}-100-2.json`, sha256: hash, size: 999},
    archive: {url: cdn + archiveName, name: archiveName, sha256: hash, size: 12345},
    otaManifest: {url: ota, sha256: hash, size: 1000},
    app: {
      pr: 4136,
      headSha: head,
      buildSha: source,
      runId: 100,
      runAttempt: 1,
      bundleId: "com.mentra.mentra",
      teamId: "T5XXXL6N36",
      backend: "dev",
      version: "3.2.1",
      build: "302010030",
      executableSha256: hash,
      javascriptSha256: hash,
      otaManifestUrl: ota,
    },
    build: {headSha: head, baseSha: base, buildSha: source},
  }
  f.request = parseRoutineRequest(json(f.request))
  return f
}

const sourceHarnessDirectory = resolve(import.meta.dir, "..")
async function harnessHash(harnessDirectory: string) {
  const hash = createHash("sha256")
  async function visit(path: string) {
    for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue
      const file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) hash.update(relative(harnessDirectory, file)).update(await readFile(file))
    }
  }
  await visit(harnessDirectory)
  return hash.digest("hex")
}
async function actualRun(
  options: {
    record?: boolean
    testPassed?: boolean
    teardownPassed?: boolean
    manual?: boolean
    mutation?: "satisfied" | "active" | "unknown"
    firmware?: {final?: Json[]; returned?: Json[]; teardown?: Json[]; mutation?: Json[]}
    collectFirmware?: (
      phase: "final" | "teardown" | "return",
      c: LifecycleContext,
    ) => ReturnType<typeof collectReturnObservation>
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ci-run-export-")))
  directories.push(root)
  const f = ready(),
    stateDirectory = join(root, "worker"),
    fixtureDirectory = join(root, "fixture")
  const harnessDirectory = join(root, "harness", "tools", "mentra-e2e")
  await mkdir(harnessDirectory, {recursive: true})
  await writeFile(
    join(harnessDirectory, "verify-run.ts"),
    await readFile(join(sourceHarnessDirectory, "verify-run.ts")),
  )
  expect(Bun.spawnSync(["git", "init", "--quiet", join(root, "harness")]).exitCode).toBe(0)
  expect(
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Offline Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Offline verifier fixture",
      ],
      {cwd: harnessDirectory},
    ).exitCode,
  ).toBe(0)
  const harnessRevision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {cwd: harnessDirectory}).stdout.toString().trim()
  Object.assign(f.request.selection!.app, {
    macPackageVersion: 2,
    macInstaller: "Install Mentra.app",
    mobileFingerprint: hash,
    mobileSourceCommit: source,
    reusedCompilation: false,
    profileUUID: "12345678-1234-1234-1234-123456789abc",
    profileExpires: "2027-05-28T04:05:18",
  })
  await mkdir(fixtureDirectory)
  await writeFile(
    join(fixtureDirectory, "fixture.json"),
    json({
      schemaVersion: 1,
      fixtureID: "offline-fixture",
      status: "ready",
      runID: "enrolled",
      runDirectory: join(root, "enrolled"),
      returnProfileDigest: hash,
    }),
  )
  const trustPath = join(root, "trust.json")
  await writeFile(trustPath, json(f.trust), {mode: 0o600})
  const trust = {path: trustPath, sha256: sha256(json(f.trust))}
  let reportDirectory = "",
    claim = {path: "", sha256: ""}
  let lifecycleOptions: LifecycleOptions | undefined,
    mutationStatus = options.mutation,
    dispatches = 0
  const observation = (passed: boolean, actual: Json = passed) => ({
    passed,
    expected: true,
    actual,
    observedAt: new Date().toISOString(),
    source: "offline fixture",
    evidence: ["offline assertion"],
  })
  const assertion = (id: string, passed = true, actual?: Json): AssertionStep => ({
    id,
    instruction: `Verify ${id}`,
    kind: "assertion",
    observe: async () => observation(passed, actual),
  })
  const local: LocalRoutineRegistration = {
    verify: async (request) => ({
      routineId: "day1-ota",
      requestSha256: sha256(Buffer.from(JSON.stringify(request))),
      harnessRevision,
      definitionDigest: hash,
      qualificationDigest: "e".repeat(64),
      fixtureID: "offline-fixture",
      fixtureDirectory,
      returnProfileDigest: hash,
    }),
    prepare: async (context) => {
      claim = {path: context.claimPath, sha256: sha256(await readFile(context.claimPath))}
      const evidence = assertion("evidence")
      if (options.record !== false)
        evidence.observe = async () => {
          reportDirectory = join(root, "report")
          await mkdir(reportDirectory)
          const mp4 = Bun.spawnSync([
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=8x8:r=10:d=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            join(reportDirectory, "routine.mp4"),
          ])
          expect(mp4.exitCode).toBe(0)
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAD0lEQVR4nGNkwAFYhpYEAAyAAB70sjDxAAAAAElFTkSuQmCC",
            "base64",
          )
          await writeFile(join(reportDirectory, "screen.png"), png)
          await writeFile(join(reportDirectory, "ax.json"), json({elements: []}))
          const status = options.testPassed === false || options.teardownPassed === false ? "failed" : "passed"
          const step = {
            id: "OTA-01",
            instruction: "Perform the offline simulated customer step",
            expected: "Step succeeds",
            status: options.testPassed === false ? "failed" : "passed",
            videoStart: 0,
            videoEnd: 0.5,
            screenshot: "screen.png",
            accessibility: "ax.json",
            screenshotVideoTime: 0.5,
            screenshotObservedVideoTime: 0.5,
            screenshotObservationAgeSeconds: 0.01,
          }
          const run = {
            executionMode: options.manual ? "interactive-discovery" : "ci-registered",
            ciLifecycle: await ciRecordingBinding({claim, trust}),
            modelCalls: 0,
            evidenceVersion: 2,
            status,
            started: new Date().toISOString(),
            ended: new Date().toISOString(),
            sourceReference: harnessRevision,
            harnessHash: await harnessHash(harnessDirectory),
            driverHash: hash,
            verifiedCiBuild: {...f.request.selection!.app, app: "Mentra.app"},
            app: {bundleId: "com.mentra.mentra", version: "3.2.1", build: "302010030"},
            appExecutableHash: hash,
            appJavascriptHash: hash,
            video: {event: "finished", duration: 1},
            results: [step],
          }
          await writeFile(join(reportDirectory, "run.json"), json(run))
          await writeFile(
            join(reportDirectory, "chapters.json"),
            json([
              {
                id: step.id,
                start: 0,
                end: 0.5,
                description: step.instruction,
                expected: step.expected,
                status: step.status,
              },
            ]),
          )
          await writeFile(join(reportDirectory, "index.html"), 'data-time="0"')
          return finalizeCiRecording({claim, trust, reportDirectory, harnessDirectory, phaseByStep: {"OTA-01": "test"}})
        }
      let dispatched = false
      const product: LifecycleStep = options.mutation
        ? {
            id: "product",
            instruction: "One simulated mutation",
            kind: "mutation",
            repeat: "never",
            execute: async () => {
              dispatched = true
              dispatches++
              return {offline: true}
            },
            reconcile: async () => ({
              expected: true,
              actual:
                dispatched && options.firmware?.mutation
                  ? {target: {firmwareAssertions: options.firmware.mutation}}
                  : dispatched,
              observedAt: new Date().toISOString(),
              source: "offline mutation fixture",
              evidence: ["offline receipt"],
              status: dispatched ? mutationStatus! : "settled",
            }),
          }
        : assertion("product", options.testPassed !== false)
      const final = assertion(
        "final",
        !options.firmware?.final?.some((c) => (c as any).status === "failed"),
        options.firmware?.final
          ? {target: {firmwareAssertions: options.firmware.final}, rawLog: "PRIVATE-RAW-LOG"}
          : undefined,
      )
      const teardown = assertion(
        "teardown",
        options.teardownPassed !== false,
        options.firmware?.teardown ? {target: {firmwareAssertions: options.firmware.teardown}} : undefined,
      )
      const returned = assertion(
        "return",
        true,
        options.firmware?.returned ? {firmwareAssertions: options.firmware.returned} : undefined,
      )
      if (options.collectFirmware)
        for (const [phase, step] of [
          ["final", final],
          ["teardown", teardown],
          ["return", returned],
        ] as const)
          step.observe = async (c) => {
            const result = await options.collectFirmware!(phase, c)
            const actual = JSON.parse(JSON.stringify(result)) as Json
            return observation(result.returnObservationPassed, phase === "return" ? actual : {target: actual})
          }
      const prepared = {
        inputs: {offlineTest: true},
        acquireLease: async () => async () => {},
        routine: {
          id: "day1-ota",
          definitionDigest: hash,
          preflight: [assertion("preflight")],
          setup: [],
          test: [product],
          finalAssertions: [final],
          teardown: [teardown],
          returnVerification: [returned],
          evidence: [evidence],
        },
      }
      lifecycleOptions = {
        ...prepared,
        runDirectory: context.runDirectory,
        fixtureDirectory,
        selection: {
          runID: context.runID,
          fixtureID: context.registration.fixtureID,
          returnProfileDigest: context.registration.returnProfileDigest,
          inputs: {request: context.request as unknown as Json, adapter: prepared.inputs},
        },
      }
      return prepared
    },
  }
  const result = await consumeRoutineRequest(f.request, f.evidence, f.trust, stateDirectory, local)
  const runDirectory = join(stateDirectory, "runs", f.request.requestId)
  return {
    root,
    claim,
    trust,
    result,
    runDirectory,
    reportDirectory,
    options: {claim, trust, outputDirectory: join(root, "export")},
    request: f.request,
    dispatches: () => dispatches,
    recover: async (status: "satisfied" | "active" | "unknown") => {
      mutationStatus = status
      if (!lifecycleOptions) throw new Error("Consumed fixture has no prepared lifecycle")
      return recoverLifecycle(lifecycleOptions)
    },
  }
}
async function edit(path: string, change: (value: any) => void) {
  const value = JSON.parse(await readFile(path, "utf8"))
  change(value)
  await writeFile(path, json(value))
}
async function journalEdit(directory: string, change: (events: any[]) => void) {
  const path = join(directory, "events.jsonl"),
    events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  change(events)
  const bytes = Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  await writeFile(path, bytes)
  // Deliberately repin the forged fixture so semantic validation still runs;
  // separate tests exercise rejection at the immutable hash boundary.
  const receiptPath = join(dirname(dirname(directory)), "claims", `${basename(directory)}.result.json`)
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
  const snapshotPath = join(directory, receipt.terminal.path)
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
  snapshot.journal = {sequence: events.length, bytes: bytes.length, sha256: sha256(bytes)}
  snapshot.state = events.at(-1).state
  snapshot.result = events.at(-1).details
  const snapshotBytes = json(snapshot)
  await writeFile(snapshotPath, snapshotBytes)
  receipt.terminal.sha256 = sha256(snapshotBytes)
  await writeFile(receiptPath, json(receipt))
}

function firmwareChecks(passed: boolean, raw?: {mtk: string; bes: string}): Json[] {
  const artifact = {url: "https://example.invalid/firmware", sha256: hash},
    profile: FirmwareProfile = {
      manifest: artifact,
      asg: {versionCode: 303006687, artifact},
      mtk: {version: "MentraLive_20260921.0", artifact},
      bes: {version: "26.9.21.3", artifact},
    },
    fixture = {usb: "PRIVATE-USB", cid: "1234".repeat(8), bluetooth: "AA:BB:CC:DD:EE:FF", serials: ["PRIVATE-SERIAL"]},
    at = new Date().toISOString(),
    bootId = "11111111-2222-3333-4444-555555555555",
    actual: FirmwareObservation = {
      at,
      evidence: "PRIVATE-EVIDENCE-PATH",
      usb: fixture.usb,
      cid: fixture.cid,
      bluetooth: fixture.bluetooth,
      serial: fixture.serials[0],
      bootId,
      bootCompleted: true,
      firmware: raw?.mtk ?? (passed ? profile.mtk.version : "MentraLive_20260709"),
      asgVersion: passed ? profile.asg.versionCode : 37,
      activeApkSha256: passed ? hash : "0".repeat(64),
      bes: {
        version: raw?.bes ?? (passed ? profile.bes.version : "17.26.1.13"),
        at,
        bootId,
        evidence: "PRIVATE-BES-PROOF",
      },
      updateIdle: true,
      appConnected: true,
    }
  // Exercise the actual 14-check producer, including private identity rows that must never be published.
  return JSON.parse(JSON.stringify(assertFirmwareState(profile, fixture, actual)))
}

async function adminView(record: unknown) {
  // Exercise the real ingest/detail schema and SSR viewer without network, MongoDB, or a device.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import React from "react";
    import {renderToStaticMarkup} from "react-dom/server";
    import {TestRunView} from "./src/pages/test-runs.tsx";
    import {TestRunService} from "../../packages/core/src/services/test-run.service.ts";
    import {createTestRunIngestApi} from "../../packages/core/src/api/internal/test-runs.api.ts";
    import {createTestRunAdminApi} from "../../packages/core/src/api/admin/test-runs.api.ts";
    const record = JSON.parse(await Bun.stdin.text()), rows = new Map();
    const repository = {
      get: async id => rows.get(id) ?? null, assets: async () => [],
      insert: async (run, payloadSha256) => {
        const stored = structuredClone({run, payloadSha256}); rows.set(run.runId, stored);
        return {stored, created: true};
      }, markUploadsComplete: async () => {},
    };
    const service = new TestRunService(repository, () => {throw new Error("No storage access expected")});
    process.env.TEST_RUN_INGEST_TOKEN = "offline-test-only-" + "x".repeat(32);
    const ingest = await createTestRunIngestApi(service).request("/", {
      method: "POST", headers: {authorization: "Bearer " + process.env.TEST_RUN_INGEST_TOKEN, "content-type": "application/json"},
      body: JSON.stringify(record),
    });
    if (ingest.status !== 201) throw new Error(await ingest.text());
    const response = await createTestRunAdminApi(service).request("/" + record.runId);
    if (response.status !== 200) throw new Error(await response.text());
    const detail = await response.json();
    console.log(JSON.stringify({detail, markup: renderToStaticMarkup(React.createElement(TestRunView, {run: detail, onStep: () => {}}))}));
  `,
    ],
    {
      cwd: resolve(sourceHarnessDirectory, "../../cloud-v2/websites/admin"),
      stdin: json(record),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    },
  )
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  return JSON.parse(child.stdout.toString().trim())
}

/** Actual publisher, ingest routes and service; only repository/storage are in-memory. */
async function publishGenerations(exports: Awaited<ReturnType<typeof exportCiRun>>[]) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
      import {join} from "node:path";
      import {TestRunService} from "../../packages/core/src/services/test-run.service.ts";
      import {createTestRunIngestApi} from "../../packages/core/src/api/internal/test-runs.api.ts";
      import {createTestRunAdminApi} from "../../packages/core/src/api/admin/test-runs.api.ts";
      import {publishTestRun} from ${JSON.stringify(join(import.meta.dir, "test-run-publisher.ts"))};
      const outputs = JSON.parse(await Bun.stdin.text()), rows = new Map(), assets = new Map(), objects = new Map();
      const repository = {
        get: async id => rows.get(id) ?? null,
        assets: async id => [...assets.values()].filter(asset => asset.runId === id),
        insert: async (run, payloadSha256) => {
          if (rows.has(run.runId)) return {stored: rows.get(run.runId), created: false};
          const stored = structuredClone({run, payloadSha256}); rows.set(run.runId, stored);
          return {stored, created: true};
        },
        insertAsset: async asset => {
          const key = asset.runId + "/" + asset.assetId;
          if (!assets.has(key)) assets.set(key, structuredClone(asset));
          return assets.get(key);
        },
        markUploadsComplete: async () => {},
      };
      const storage = {
        putFile: async ({key, path}) => {objects.set(key, await Bun.file(path).arrayBuffer());},
        statObject: async key => ({sizeBytes: objects.get(key).byteLength}),
        deleteObject: async key => {objects.delete(key);},
      };
      const service = new TestRunService(repository, () => storage);
      process.env.TEST_RUN_INGEST_TOKEN = "offline-test-only-" + "x".repeat(32);
      const app = createTestRunIngestApi(service);
      const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch(request) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith("/api/internal/test-runs")) return new Response(null, {status: 404});
        url.pathname = url.pathname.slice("/api/internal/test-runs".length) || "/";
        return app.fetch(new Request(url, request));
      }});
      const options = output => ({
        metadataPath: join(output.outputDirectory, "run.json"), assetsPath: join(output.outputDirectory, "assets.json"),
        evidenceRoot: output.outputDirectory, journalPath: join(output.outputDirectory, "publication.jsonl"),
        coreUrl: server.url.origin, adminUrl: "https://admin.example.invalid", token: process.env.TEST_RUN_INGEST_TOKEN,
      });
      try {
        const publications = [];
        for (const output of outputs) publications.push(await publishTestRun(options(output)));
        const replay = await publishTestRun(options(outputs[0]));
        const forged = structuredClone(outputs[1].result); forged.runId = outputs[0].runId;
        const conflict = await app.request("/", {
          method: "POST", headers: {authorization: "Bearer " + process.env.TEST_RUN_INGEST_TOKEN, "content-type": "application/json"},
          body: JSON.stringify(forged),
        });
        const details = [];
        for (const output of outputs) {
          const response = await createTestRunAdminApi(service).request("/" + output.runId);
          if (response.status !== 200) throw new Error(await response.text());
          details.push(await response.json());
        }
        console.log(JSON.stringify({publications, replay, conflict: conflict.status, details, rows: rows.size, assets: assets.size}));
      } finally {server.stop(true);}
    `,
    ],
    {
      cwd: resolve(sourceHarnessDirectory, "../../cloud-v2/websites/admin"),
      stdin: json(exports),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    },
  )
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  return JSON.parse(child.stdout.toString().trim())
}

describe("consumed CI lifecycle export", () => {
  test("preserves valid raw version encodings accepted by the actual firmware checker", async () => {
    for (const raw of [
      {mtk: "20260921.0", bes: "026.09.021.003"},
      {mtk: "MentraLive_20260921.0", bes: "26.9.21.3"},
    ]) {
      const checks = firmwareChecks(true, raw)
      expect(checks.every((c) => (c as any).status === "passed")).toBe(true)
      const f = await actualRun({record: false, firmware: {final: checks, returned: checks}}),
        exported = await exportCiRun(f.options)
      expect(exported.result.outcomes.test).toBe("passed")
      expect(exported.result.firmwareAssertions).toHaveLength(8)
      expect(exported.result.firmwareAssertions.find((r) => r.component === "MTK version")?.actual).toBe(raw.mtk)
      expect(exported.result.firmwareAssertions.find((r) => r.component === "BES version")?.actual).toBe(raw.bes)
    }
  })
  test("publishes all four final firmware failures beside successful cleanup through the admin API and viewer", async () => {
    const f = await actualRun({
        record: false,
        collectFirmware: async (phase, c) => {
          const output = join(c.runDirectory, `simulated-collector-${phase}`)
          await mkdir(output)
          const s = simulatedReturnCollection(output)
          const source = structuredClone(s.config.profile)
          source.mtk.version = "MentraLive_20260709"
          source.asg.versionCode = 303006000
          source.asg.artifact.sha256 = "e".repeat(64)
          source.bes.version = "17.26.1.13"
          s.config.allowedSource = day1ReturnSources(s.config.profile, {sourceProfiles: [source]})
          if (phase === "final") {
            s.flags.firmware = source.mtk.version
            s.flags.asgVersion = source.asg.versionCode
            s.flags.wrongApk = true
            s.flags.besVersion = source.bes.version
          }
          const result = await collectReturnObservation(s.config, s.app)
          expect(result.firmwareAssertions).toHaveLength(14)
          expect(result.returnObservationPassed).toBe(phase !== "final")
          expect(result.idleChecks.every((check) => check.passed)).toBe(true)
          expect(result.fixtureStateChanged).toBe(false)
          return result
        },
      }),
      exported = await exportCiRun(f.options),
      rows = exported.result.firmwareAssertions
    expect(exported.result.outcomes).toMatchObject({test: "failed", teardown: "passed", fixture: "ready"})
    expect(rows).toHaveLength(12)
    for (const phase of ["final-assertions", "teardown", "return-verification"])
      expect(rows.filter((r) => r.phase === phase).map((r) => r.status)).toEqual(
        Array(4).fill(phase === "final-assertions" ? "failed" : "passed"),
      )
    expect(rows.slice(0, 4).map((r) => [r.component, r.actual])).toEqual([
      ["MTK version", "MentraLive_20260709"],
      ["ASG version", "303006000"],
      ["ASG APK SHA-256", "e".repeat(64)],
      ["BES version", "17.26.1.13"],
    ])
    const summary = JSON.parse(await readFile(join(exported.outputDirectory, "lifecycle-summary.json"), "utf8"))
    expect(summary.firmwareAssertions).toEqual(rows)
    for (const privateValue of [
      "PRIVATE-",
      "AA:BB:CC:DD:EE:01",
      "0123456789abcdef0123456789abcdef",
      "TEST012345",
      "da1ae189-2166-4d4b-8069-806e570bb530",
    ])
      expect(JSON.stringify({record: exported.result, summary})).not.toContain(privateValue)
    const {detail, markup} = await adminView(exported.result)
    expect(detail.firmwareAssertions).toEqual(rows)
    expect(detail.outcomes).toEqual(exported.result.outcomes)
    expect(markup).toContain("Final test checks")
    expect(markup).toContain("Teardown")
    expect(markup).toContain("Return verification")
    expect(markup).toContain("17.26.1.13")
    expect(markup).toContain("26.9.21.3")
  })
  test("projects owned reconciliation checks and sanitizes absent or malformed failed observations", async () => {
    const checks = firmwareChecks(true)
    const f = await actualRun({record: false, mutation: "satisfied", firmware: {mutation: checks}}),
      exported = await exportCiRun(f.options)
    expect(exported.result.firmwareAssertions).toHaveLength(4)
    expect(exported.result.firmwareAssertions.every((r) => r.phase === "test" && r.status === "passed")).toBe(true)
    const absent = firmwareChecks(false)
    ;(absent.find((r) => (r as any).id === "firmware.bes.version") as any).actual = null
    ;(absent.find((r) => (r as any).id === "firmware.mtk") as any).actual = {credential: "PRIVATE-CREDENTIAL"}
    const missing = await actualRun({record: false, firmware: {final: absent}}),
      safe = await exportCiRun(missing.options)
    expect(safe.result.firmwareAssertions.find((r) => r.component === "BES version")?.actual).toBe("Not observed")
    expect(safe.result.firmwareAssertions.find((r) => r.component === "MTK version")?.actual).toBe(
      "Invalid observation",
    )
    expect(JSON.stringify(safe.result)).not.toContain("PRIVATE-CREDENTIAL")
  })
  test("rejects malformed expected firmware and a passed check without a publishable value", async () => {
    for (const field of ["expected", "actual"] as const) {
      const checks = firmwareChecks(true)
      ;(checks.find((r) => (r as any).id === "firmware.mtk") as any)[field] = "PRIVATE-INVALID"
      const f = await actualRun({record: false, firmware: {final: checks}})
      await expect(exportCiRun(f.options)).rejects.toThrow(field === "expected" ? "expected firmware" : "valid value")
    }
  })
  test("exports actual completed intake/lifecycle with independently verified recording and immutable asset bytes", async () => {
    const f = await actualRun(),
      exported = await exportCiRun(f.options)
    expect(f.result.status).toBe("routine-finished")
    expect(exported.result.outcome).toBe("passed")
    expect(exported.result.outcomes).toEqual({
      test: "passed",
      teardown: "passed",
      fixture: "ready",
      evidence: "complete",
    })
    expect(exported.result.provenance.requestRelationship).toBe("consumed")
    expect(exported.result.provenance.mobileSourceCommit).toBe(source)
    expect(testRunSchema.safeParse(exported.result).success).toBe(true)
    expect(exported.result.assets.some((a) => a.kind === "video")).toBe(true)
    for (const asset of exported.result.assets)
      expect(sha256(await readFile(join(exported.outputDirectory, asset.filename)))).toBe(asset.sha256)
    expect(await readFile(join(exported.outputDirectory, "lifecycle-summary.json"), "utf8")).not.toContain(
      "offline assertion",
    )
    await expect(exportCiRun(f.options)).rejects.toThrow()
  })
  test("complete recording cannot erase a failed test or failed teardown", async () => {
    for (const opts of [{testPassed: false}, {teardownPassed: false}]) {
      const f = await actualRun(opts),
        exported = await exportCiRun(f.options)
      expect(exported.result.outcome).toBe("failed")
      expect(exported.result.outcomes.evidence).toBe("complete")
      expect(exported.result.outcomes.test).toBe(opts.testPassed === false ? "failed" : "passed")
      expect(exported.result.outcomes.teardown).toBe(opts.teardownPassed === false ? "failed" : "passed")
    }
  })
  test("accepts a settled actual journal mutation and preserves unknown post-dispatch recovery", async () => {
    const f = await actualRun({mutation: "satisfied"}),
      exported = await exportCiRun(f.options)
    expect(exported.result.outcome).toBe("passed")
    const unknown = await actualRun({record: false, mutation: "unknown"}),
      blocked = await exportCiRun(unknown.options)
    expect(blocked.result.outcome).toBe("failed")
    expect(blocked.result.outcomes.fixture).toBe("unavailable")
    expect(blocked.result.provenance.returnVerification).toBe("deferred")
    expect(
      JSON.parse(await readFile(join(blocked.outputDirectory, "lifecycle-summary.json"), "utf8")).mutations[0]
        .reconciliation,
    ).toBe("unknown")
  })
  for (const status of ["active", "unknown"] as const)
    test(`exports and uploads original ${status} failure only after same-run recovery without relabeling it`, async () => {
      const f = await actualRun({record: false, mutation: status})
      const receiptPath = join(dirname(f.claim.path), `${f.request.requestId}.result.json`)
      const receiptBytes = await readFile(receiptPath)
      const receipt = JSON.parse(receiptBytes.toString())
      const originalPath = join(f.runDirectory, receipt.terminal.path)
      const originalBytes = await readFile(originalPath)
      const originalJournal = await readFile(join(f.runDirectory, "events.jsonl"))
      expect(receipt.lifecycle).toMatchObject({test: "failed", fixture: "recovery-required", outcome: "failed"})
      expect(f.dispatches()).toBe(1)
      expect(await readdir(f.root)).not.toContain("export")

      const recovered = await f.recover("satisfied")
      expect(recovered).toMatchObject({
        test: "failed",
        teardown: "passed",
        returnVerification: "passed",
        fixture: "ready",
        outcome: "failed",
      })
      expect(f.dispatches()).toBe(1)
      expect(await readFile(receiptPath)).toEqual(receiptBytes)
      expect(await readFile(originalPath)).toEqual(originalBytes)
      expect((await readFile(join(f.runDirectory, "events.jsonl"))).subarray(0, originalJournal.length)).toEqual(
        originalJournal,
      )
      const recoveredPath = join(f.runDirectory, recovered.terminal.path)
      const recoveredSnapshot = JSON.parse(await readFile(recoveredPath, "utf8"))
      expect(recoveredSnapshot.generation).toBe(2)
      expect(recoveredSnapshot.previous).toEqual(receipt.terminal)
      expect(sha256(await readFile(recoveredPath))).toBe(recovered.terminal.sha256)

      // Neither publication exists until after recovery has replaced the mutable
      // state/result checkpoints. The worker receipt must still select generation 1.
      const original = await exportCiRun(f.options)
      const recovery = await exportCiRun({
        ...f.options,
        outputDirectory: join(f.root, "recovery-export"),
        terminal: {...recovered.terminal, path: recoveredPath},
      })
      expect(original.result.outcomes).toEqual({
        test: "failed",
        teardown: "blocked",
        fixture: "unavailable",
        evidence: "incomplete",
      })
      expect(recovery.result.outcomes).toEqual({
        test: "failed",
        teardown: "passed",
        fixture: "ready",
        evidence: "incomplete",
      })
      expect(original.result.outcome).toBe("failed")
      expect(recovery.result.outcome).toBe("failed")
      expect(original.runId).toBe(receipt.runID)
      expect(recovery.runId).not.toBe(original.runId)
      expect(recovery.result.requestId).toBe(original.result.requestId)
      expect(original.result.provenance.resultGeneration).toBe("1")
      expect(recovery.result.provenance).toMatchObject({
        resultGeneration: "2",
        originalRunId: original.runId,
        previousResultRunId: original.runId,
        originalTerminalSnapshotSha256: receipt.terminal.sha256,
        terminalSnapshotSha256: recovered.terminal.sha256,
      })
      expect(original.result.finishedAt).toBe(receipt.at)
      const recoveryEvents = (await readFile(join(f.runDirectory, "events.jsonl"), "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(recovery.result.finishedAt).toBe(recoveryEvents.at(-1).timestamp)
      const summaries = await Promise.all(
        [original, recovery].map(async (output) =>
          JSON.parse(await readFile(join(output.outputDirectory, "lifecycle-summary.json"), "utf8")),
        ),
      )
      expect(summaries[0].mutations[0].reconciliation).toBe(status)
      expect(summaries[1].mutations[0].reconciliation).toBe("satisfied")

      const published = await publishGenerations([original, recovery])
      expect(published.rows).toBe(2)
      expect(published.assets).toBe(2)
      expect(published.publications.map((p: any) => p.sourceOutcome)).toEqual(["failed", "failed"])
      expect(published.publications.every((p: any) => p.publication === "complete")).toBe(true)
      expect(published.replay.uploadedAssets).toBe(0)
      expect(published.conflict).toBe(409)
      expect(published.details.map((d: any) => d.outcomes)).toEqual([
        original.result.outcomes,
        recovery.result.outcomes,
      ])
      expect(published.details.every((d: any) => d.assets.every((asset: any) => asset.uploaded))).toBe(true)
      expect(f.dispatches()).toBe(1)
    }, 20000)
  test("metadata-only completion remains unqualified and preserves independent phase outcomes", async () => {
    const f = await actualRun({record: false}),
      exported = await exportCiRun(f.options)
    expect(exported.result.outcome).toBe("blocked")
    expect(exported.result.outcomes).toEqual({
      test: "passed",
      teardown: "passed",
      fixture: "ready",
      evidence: "incomplete",
    })
    expect(exported.result.chapters).toEqual([])
    expect(exported.result.assets).toHaveLength(1)
  })
  test("manual discovery cannot produce a CI recording descriptor or be exported as CI evidence", async () => {
    const f = await actualRun({manual: true}),
      exported = await exportCiRun(f.options)
    expect(exported.result.outcome).toBe("blocked")
    expect(exported.result.outcomes.evidence).toBe("incomplete")
    expect(exported.result.assets.some((a) => a.kind === "video")).toBe(false)
    const state = JSON.parse(await readFile(join(f.runDirectory, "state.json"), "utf8"))
    expect(state.phases.evidence).toBe("failed")
  })
  test("rejects missing registration, wrong claim hash or untrusted actual source", async () => {
    const f = await actualRun({record: false})
    await expect(exportCiRun({...f.options, claim: {...f.claim, sha256: "0".repeat(64)}})).rejects.toThrow(
      "hash mismatch",
    )
    await edit(f.claim.path, (v) => (v.registration = null))
    await expect(
      exportCiRun({...f.options, claim: {...f.claim, sha256: sha256(await readFile(f.claim.path))}}),
    ).rejects.toThrow("Registered routine")
  })
  test("rejects interrupted result, partial journal and stale checkpoint instead of treating retries as completed", async () => {
    const f = await actualRun({record: false})
    const checkpoint = await readFile(join(f.runDirectory, "state.json"))
    await edit(join(f.runDirectory, "state.json"), (v) => (v.test = "failed"))
    await expect(exportCiRun(f.options)).rejects.toThrow("Checkpoint differs")
    await writeFile(join(f.runDirectory, "state.json"), checkpoint)
    const journal = await readFile(join(f.runDirectory, "events.jsonl"))
    await writeFile(join(f.runDirectory, "events.jsonl"), journal.subarray(0, journal.length - 1))
    await expect(exportCiRun(f.options)).rejects.toThrow(/Partial lifecycle|journal bounds/)
    await writeFile(join(f.runDirectory, "events.jsonl"), journal)
    await edit(
      join(dirname(f.claim.path), `${f.request.requestId}.result.json`),
      (v) => (v.status = "routine-interrupted"),
    )
    await expect(exportCiRun(f.options)).rejects.toThrow("original completed")
  })
  test("rejects changed original terminal bytes or journal prefix before semantic validation", async () => {
    for (const mode of ["snapshot", "journal"] as const) {
      const f = await actualRun({record: false})
      const receipt = JSON.parse(
        await readFile(join(dirname(f.claim.path), `${f.request.requestId}.result.json`), "utf8"),
      )
      if (mode === "snapshot") await edit(join(f.runDirectory, receipt.terminal.path), (v) => v.generation++)
      else {
        const path = join(f.runDirectory, "events.jsonl")
        await writeFile(path, (await readFile(path, "utf8")).replace('"run-started"', '"bad-started"'))
      }
      await expect(exportCiRun(f.options)).rejects.toThrow(
        mode === "snapshot" ? "snapshot hash mismatch" : "prefix hash mismatch",
      )
    }
  })
  test("explicit recovery cannot discard its link to the worker's original snapshot", async () => {
    const f = await actualRun({record: false, mutation: "unknown"})
    const recovered = await f.recover("satisfied")
    const path = join(f.runDirectory, recovered.terminal.path)
    await edit(path, (v) => (v.previous = null))
    await expect(exportCiRun({...f.options, terminal: {path, sha256: sha256(await readFile(path))}})).rejects.toThrow(
      "not linked to the worker's original",
    )
    expect(f.dispatches()).toBe(1)
  })
  test("historical export ignores a partial later recovery suffix and mutable checkpoint", async () => {
    const f = await actualRun({record: false, mutation: "unknown"})
    await f.recover("satisfied")
    const path = join(f.runDirectory, "events.jsonl")
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('{"sequence":')]))
    await writeFile(join(f.runDirectory, "state.json"), '{"mode":"recovering"')
    const exported = await exportCiRun(f.options)
    expect(exported.result.provenance.resultGeneration).toBe("1")
    expect(exported.result.outcomes).toEqual({
      test: "failed",
      teardown: "blocked",
      fixture: "unavailable",
      evidence: "incomplete",
    })
    expect(f.dispatches()).toBe(1)
  })
  test("rejects recording bytes changed after successful verification", async () => {
    const f = await actualRun()
    await writeFile(join(f.runDirectory, "recording", "screen.png"), Buffer.from("changed"))
    await expect(exportCiRun(f.options)).rejects.toThrow("verified inventory")
  })
  test("rejects report path escape or descriptor from another claim", async () => {
    for (const mode of ["escape", "claim"]) {
      const f = await actualRun()
      await journalEdit(f.runDirectory, (events) => {
        const event = events.find((e) => e.type === "assertion" && e.phase === "evidence")
        if (mode === "escape") {
          event.details.actual.report.path = "../manual/run.json"
          event.details.evidence[0] = "../manual/run.json"
        } else event.details.actual.binding.claimSha256 = "0".repeat(64)
      })
      await expect(exportCiRun(f.options)).rejects.toThrow(mode === "escape" ? "escapes" : "another claim")
    }
  })
  test("rejects forged phase pass and dispatch without its durable intent", async () => {
    for (const mode of ["assertion", "dispatch"]) {
      const f = await actualRun({record: false})
      await journalEdit(f.runDirectory, (events) => {
        if (mode === "assertion")
          events.find((e) => e.phase === "final-assertions" && e.type === "assertion").details.passed = false
        else {
          const e = events.find((e) => e.type === "step-started")
          e.type = "mutation-dispatched"
          e.details = {operationID: "missing"}
        }
      })
      await expect(exportCiRun(f.options)).rejects.toThrow(
        mode === "assertion" ? "independent assertions" : "durable intent",
      )
    }
  })
  test("does not permit checkpoint/result edits to manufacture a ready fixture", async () => {
    const f = await actualRun({record: false, mutation: "unknown"})
    await journalEdit(f.runDirectory, (events) => {
      const last = events.at(-1)
      last.state.phases.teardown = "passed"
      last.state.phases["return-verification"] = "passed"
      delete last.state.activeOperationID
      delete last.state.pendingReconciliation
      last.details.teardown = "passed"
      last.details.returnVerification = "passed"
      last.details.fixture = "ready"
    })
    const last = JSON.parse((await readFile(join(f.runDirectory, "events.jsonl"), "utf8")).trim().split("\n").at(-1)!)
    await writeFile(join(f.runDirectory, "state.json"), json(last.state))
    await writeFile(join(f.runDirectory, "result.json"), json(last.details))
    await edit(join(dirname(f.claim.path), `${f.request.requestId}.result.json`), (v) => (v.lifecycle = last.details))
    await expect(exportCiRun(f.options)).rejects.toThrow("unresolved mutation")
  })
  test("rejects a symlink to external evidence", async () => {
    const f = await actualRun(),
      path = join(f.runDirectory, "recording", "screen.png")
    await rm(path)
    await symlink(join(f.reportDirectory, "screen.png"), path)
    await expect(exportCiRun(f.options)).rejects.toThrow("symlinks")
  })
})
