import {afterEach, describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {dirname, join, relative, resolve} from "node:path"
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
import type {AssertionStep, LifecycleStep} from "./lifecycle"
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
    mutation?: "satisfied" | "unknown"
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
  const observation = (passed: boolean) => ({
    passed,
    expected: true,
    actual: passed,
    observedAt: new Date().toISOString(),
    source: "offline fixture",
    evidence: ["offline assertion"],
  })
  const assertion = (id: string, passed = true): AssertionStep => ({
    id,
    instruction: `Verify ${id}`,
    kind: "assertion",
    observe: async () => observation(passed),
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
              return {offline: true}
            },
            reconcile: async () => ({
              expected: true,
              actual: dispatched,
              observedAt: new Date().toISOString(),
              source: "offline mutation fixture",
              evidence: ["offline receipt"],
              status: dispatched ? options.mutation! : "settled",
            }),
          }
        : assertion("product", options.testPassed !== false)
      return {
        inputs: {offlineTest: true},
        acquireLease: async () => async () => {},
        routine: {
          id: "day1-ota",
          definitionDigest: hash,
          preflight: [assertion("preflight")],
          setup: [],
          test: [product],
          finalAssertions: [assertion("final")],
          teardown: [assertion("teardown", options.teardownPassed !== false)],
          returnVerification: [assertion("return")],
          evidence: [evidence],
        },
      }
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
  await writeFile(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
}

describe("consumed CI lifecycle export", () => {
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
    await expect(exportCiRun(f.options)).rejects.toThrow("Partial lifecycle")
    await writeFile(join(f.runDirectory, "events.jsonl"), journal)
    await edit(
      join(dirname(f.claim.path), `${f.request.requestId}.result.json`),
      (v) => (v.status = "routine-interrupted"),
    )
    await expect(exportCiRun(f.options)).rejects.toThrow("original completed")
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
