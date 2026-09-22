import {describe, expect, test} from "bun:test"
import {execFileSync} from "node:child_process"
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {extractRequest} from "../ci-worker"
import {
  assertRequestTrust,
  consumeRoutineRequest,
  parseRequestTrust,
  parseRoutineRequest,
  REQUEST_REPOSITORY,
  REQUEST_WORKFLOW,
  sha256,
  type LocalRoutineRegistration,
  type RequestEvidence,
  type RequestTrust,
} from "./ci-request"
import type {AssertionStep} from "./lifecycle"

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

async function simulatedRegistration(directory: string) {
  await mkdir(join(directory, "fixture"), {mode: 0o700})
  await writeFile(
    join(directory, "fixture", "fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      fixtureID: "simulated-fixture",
      status: "ready",
      runID: "simulated-enrollment",
      runDirectory: join(directory, "simulated-enrollment"),
      returnProfileDigest: hash,
    }),
  )
  const calls: string[] = []
  let dispatched = false
  const proof = (passed: boolean) => ({
    passed,
    expected: true,
    actual: passed,
    observedAt: new Date().toISOString(),
    source: "offline simulated routine",
    evidence: ["simulated-observation.json"],
  })
  const assertion = (id: string): AssertionStep => ({
    kind: "assertion",
    id,
    instruction: `Verify simulated ${id}.`,
    observe: async () => proof(true),
  })
  const local: LocalRoutineRegistration = {
    verify: async (request) => {
      calls.push("verify")
      return {
        routineId: "day1-ota",
        requestSha256: sha256(json(request)),
        harnessRevision: "e".repeat(40),
        definitionDigest: hash,
        qualificationDigest: "f".repeat(64),
        fixtureID: "simulated-fixture",
        fixtureDirectory: join(directory, "fixture"),
        returnProfileDigest: hash,
      }
    },
    prepare: async (context) => {
      const claim = JSON.parse(await readFile(context.claimPath, "utf8"))
      expect(claim.runID).toBe(context.runID)
      expect(claim.runDirectory).toBe(context.runDirectory)
      expect(claim.registration).toEqual(context.registration)
      expect(claim.requestSha256).toBe(sha256(json(context.request)))
      expect(await Bun.file(join(directory, "worker-lease.json")).exists()).toBe(true)
      calls.push("prepare-after-claim")
      return {
        inputs: {simulated: true},
        acquireLease: async () => {
          calls.push("acquire-harness-lease")
          return async () => {
            calls.push("release-harness-lease")
          }
        },
        routine: {
          id: "day1-ota",
          definitionDigest: hash,
          preflight: [assertion("identity")],
          setup: [],
          test: [
            {
              id: "customer",
              instruction: "Run the simulated customer sequence once.",
              kind: "mutation",
              repeat: "never",
              execute: async (_context, intent) => {
                const journal = await readFile(join(context.runDirectory, "events.jsonl"), "utf8")
                expect(JSON.parse(journal.trim().split("\n").at(-1)!)).toMatchObject({
                  type: "mutation-intent",
                  stepID: "customer",
                })
                expect(journal).toContain(intent.operationID)
                dispatched = true
                calls.push("customer-after-intent")
              },
              reconcile: async () => ({...proof(dispatched), status: dispatched ? "satisfied" : "settled"}),
            },
          ],
          finalAssertions: [assertion("target")],
          teardown: [],
          returnVerification: [assertion("return")],
          evidence: [assertion("evidence")],
        },
      }
    },
  }
  return {local, calls}
}

describe("private CI request intake", () => {
  test("accepts only authenticated run and artifact identity with the exact approved merge", () => {
    const f = fixture()
    expect(() => assertRequestTrust(f.request, parseRequestTrust(json(f.trust)), f.evidence)).not.toThrow()
    for (const tamper of [
      (x: typeof f) => {
        x.evidence.run.head_sha = "e".repeat(40)
      },
      (x: typeof f) => {
        x.evidence.run.event = "pull_request_target"
      },
      (x: typeof f) => {
        x.evidence.run.path = ".github/workflows/other.yml"
      },
      (x: typeof f) => {
        x.evidence.artifact.workflow_run.id = 201
      },
      (x: typeof f) => {
        x.evidence.artifact.digest = `sha256:${"e".repeat(64)}`
      },
      (x: typeof f) => {
        x.evidence.currentPr.head.sha = "e".repeat(40)
      },
      (x: typeof f) => {
        x.evidence.currentBaseRef.object.sha = "e".repeat(40)
      },
      (x: typeof f) => {
        x.evidence.currentPr.labels = []
      },
      (x: typeof f) => {
        x.evidence.sourceCommit.parents.reverse()
      },
      (x: typeof f) => {
        x.trust.entries[0].sourceSha = "e".repeat(40)
      },
      (x: typeof f) => {
        x.request.trigger.workflowSha = "e".repeat(40)
      },
    ]) {
      const changed = fixture()
      tamper(changed)
      expect(() => assertRequestTrust(changed.request, changed.trust, changed.evidence)).toThrow()
    }
  })

  test("stale PR base metadata is accepted only when the actual dev ref and merge parents match", () => {
    const f = fixture()
    f.evidence.currentPr.base.sha = "e".repeat(40)
    expect(() => assertRequestTrust(f.request, f.trust, f.evidence)).not.toThrow()
    for (const change of [
      (x: typeof f) => {
        x.evidence.currentBaseRef.object.sha = "e".repeat(40)
      },
      (x: typeof f) => {
        x.evidence.currentBaseRef.ref = "refs/heads/staging"
      },
      (x: typeof f) => {
        x.evidence.currentBaseRef.object.type = "tag"
      },
      (x: typeof f) => {
        x.evidence.sourceCommit.parents[0].sha = "e".repeat(40)
      },
      (x: typeof f) => {
        x.trust.entries[0].baseSha = "e".repeat(40)
      },
      (x: typeof f) => {
        x.evidence.currentPr.base.ref = "staging"
      },
      (x: typeof f) => {
        delete (x.evidence as Partial<RequestEvidence>).currentBaseRef
      },
    ]) {
      const changed = structuredClone(f)
      change(changed)
      expect(() => assertRequestTrust(changed.request, changed.trust, changed.evidence)).toThrow()
    }
  })

  test("rejects executable fields, arbitrary URLs, malformed IDs and inconsistent selected artifacts", () => {
    for (const tamper of [
      (x: any) => {
        x.command = "do anything"
      },
      (x: any) => {
        x.routine.command = "do anything"
      },
      (x: any) => {
        x.requestId = "../../elsewhere"
      },
      (x: any) => {
        x.selection.archive.url = "http://localhost/private"
      },
      (x: any) => {
        x.selection.app.headSha = "e".repeat(40)
      },
      (x: any) => {
        x.selection.producer.buildAttempt = 3
      },
      (x: any) => {
        x.status = "passed"
      },
      (x: any) => {
        x.selection.otaManifest.sha256 = "invalid"
      },
    ]) {
      const f = ready()
      tamper(f.request)
      expect(() => parseRoutineRequest(json(f.request))).toThrow()
    }
  })

  test("ready is only artifact selection; consuming records unqualified and never passes hardware", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      const f = ready()
      const result = await consumeRoutineRequest(f.request, f.evidence, f.trust, directory)
      expect(result.status).toBe("blocked-unqualified")
      expect(result.hardwareStarted).toBe(false)
      const claim = JSON.parse(await readFile(join(directory, "claims", `${f.request.requestId}.json`), "utf8"))
      expect(claim.request.selection.archive.sha256).toBe(hash)
      expect(claim.evidence.archiveSha256).toBe(hash)
      expect((await consumeRoutineRequest(f.request, f.evidence, f.trust, directory)).status).toBe("already-claimed")
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("no-artifact is persisted separately; partial claims prevent replay even without a result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      const f = fixture()
      expect((await consumeRoutineRequest(f.request, f.evidence, f.trust, directory)).status).toBe("no-artifact")
      const resultPath = join(directory, "claims", `${f.request.requestId}.result.json`)
      await rm(resultPath)
      await writeFile(join(directory, "claims", `${f.request.requestId}.json`), '{"partial":')
      expect((await consumeRoutineRequest(f.request, f.evidence, f.trust, directory)).status).toBe("already-claimed")
      expect(await Bun.file(resultPath).exists()).toBe(false)
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("an abandoned or partial global lease blocks a different new request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      await mkdir(join(directory, "claims"), {mode: 0o700})
      await writeFile(join(directory, "worker-lease.json"), "")
      const f = fixture()
      await expect(consumeRoutineRequest(f.request, f.evidence, f.trust, directory)).rejects.toThrow(/lease exists/)
      expect(await Bun.file(join(directory, "claims", `${f.request.requestId}.json`)).exists()).toBe(false)
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("a locally verified registration enters one lifecycle only after the durable claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      const f = ready()
      const {local, calls} = await simulatedRegistration(directory)
      const result = await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)
      expect(result).toMatchObject({
        status: "routine-finished",
        runID: f.request.requestId,
        runDirectory: join(directory, "runs", f.request.requestId),
        dispatchStarted: true,
        lifecycle: {test: "passed", teardown: "passed", returnVerification: "passed", fixture: "ready"},
      })
      expect("hardwareStarted" in result).toBe(false)
      expect(calls).toEqual([
        "verify",
        "prepare-after-claim",
        "acquire-harness-lease",
        "customer-after-intent",
        "release-harness-lease",
      ])
      const claim = JSON.parse(await readFile(join(directory, "claims", `${f.request.requestId}.json`), "utf8"))
      expect(claim.registration.harnessRevision).not.toBe(f.request.routine.harnessRevision)
      expect(await Bun.file(join(directory, "worker-lease.json")).exists()).toBe(false)
      expect(
        JSON.parse(await readFile(join(directory, "claims", `${f.request.requestId}.result.json`), "utf8")),
      ).toEqual(result)
      expect((await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)).status).toBe(
        "already-claimed",
      )
      expect(calls).toHaveLength(5)
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("unqualified and no-artifact requests never invoke registered preparation", async () => {
    for (const hasArtifact of [true, false]) {
      const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
      try {
        const f = hasArtifact ? ready() : fixture()
        const {local, calls} = await simulatedRegistration(directory)
        local.verify = async () => {
          calls.push("unqualified")
          return null
        }
        const result = await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)
        expect(result.status).toBe(hasArtifact ? "blocked-unqualified" : "no-artifact")
        expect(calls).toEqual(hasArtifact ? ["unqualified"] : [])
        expect(await Bun.file(join(directory, "runs", f.request.requestId, "run.json")).exists()).toBe(false)
      } finally {
        await rm(directory, {recursive: true, force: true})
      }
    }
  })

  test("request and local registration validation precede all dispatch and claims", async () => {
    for (const invalid of ["request", "untrusted", "stale-registration", "invalid-path"]) {
      const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
      try {
        const f = ready()
        const {local, calls} = await simulatedRegistration(directory)
        const verify = local.verify
        if (invalid === "request") f.request.requestId = "../escape"
        else if (invalid === "untrusted") f.evidence.currentBaseRef.object.sha = "e".repeat(40)
        else
          local.verify = async (request) => {
            const result = (await verify(request))!
            if (invalid === "stale-registration") result.requestSha256 = "e".repeat(64)
            else result.fixtureDirectory = "./fixture"
            return result
          }
        await expect(consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)).rejects.toThrow()
        expect(calls).toEqual(["request", "untrusted"].includes(invalid) ? [] : ["verify"])
        expect(await Bun.file(join(directory, "claims", "routine-200-1-4136-day1-ota.json")).exists()).toBe(false)
        expect(await Bun.file(join(directory, "worker-lease.json")).exists()).toBe(false)
      } finally {
        await rm(directory, {recursive: true, force: true})
      }
    }
  })

  test("preparation failure records interruption and retains the lease without replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      const f = ready()
      const {local, calls} = await simulatedRegistration(directory)
      local.prepare = async ({claimPath}) => {
        expect(await Bun.file(claimPath).exists()).toBe(true)
        calls.push("failed-preparation")
        throw new Error("Sensitive adapter exception must not enter result metadata")
      }
      const result = await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)
      expect(result).toMatchObject({status: "routine-interrupted", lifecycle: null, runID: f.request.requestId})
      expect(JSON.stringify(result)).not.toContain("Sensitive")
      const diagnosticPath = join(directory, "claims", `${f.request.requestId}.failure.json`)
      expect(JSON.parse(await readFile(diagnosticPath, "utf8")).error.message).toContain("Sensitive adapter exception")
      expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600)
      expect(
        JSON.parse(await readFile(join(directory, "claims", `${f.request.requestId}.result.json`), "utf8")),
      ).toEqual(result)
      expect(await Bun.file(join(directory, "worker-lease.json")).exists()).toBe(true)
      expect((await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)).status).toBe(
        "already-claimed",
      )
      expect(calls).toEqual(["verify", "failed-preparation"])
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("failure-diagnostic persistence errors retain the claim and lease without a terminal result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      const f = ready()
      const {local, calls} = await simulatedRegistration(directory)
      local.prepare = async () => {
        calls.push("failed-preparation")
        await writeFile(join(directory, "claims", `${f.request.requestId}.failure.json`), "preserve-existing")
        throw new Error("diagnostic write must not overwrite")
      }
      await expect(consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)).rejects.toThrow()
      expect(await Bun.file(join(directory, "worker-lease.json")).exists()).toBe(true)
      expect(await Bun.file(join(directory, "claims", `${f.request.requestId}.result.json`)).exists()).toBe(false)
      expect(await readFile(join(directory, "claims", `${f.request.requestId}.failure.json`), "utf8")).toBe(
        "preserve-existing",
      )
      expect((await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)).status).toBe(
        "already-claimed",
      )
      expect(calls).toEqual(["verify", "failed-preparation"])
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("an enrolled fixture disappearing before the resource lease cannot be silently enrolled again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      const f = ready()
      const {local, calls} = await simulatedRegistration(directory)
      const verify = local.verify
      local.verify = async (request) => {
        const result = await verify(request)
        await rm(join(directory, "fixture", "fixture.json"))
        return result
      }
      expect((await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)).status).toBe(
        "routine-interrupted",
      )
      expect(calls).toEqual(["verify", "prepare-after-claim", "acquire-harness-lease", "release-harness-lease"])
      expect(await Bun.file(join(directory, "fixture", "fixture.json")).exists()).toBe(false)
      expect(await Bun.file(join(directory, "runs", f.request.requestId, "run.json")).exists()).toBe(false)
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("a changed prepared definition fails before its resource lease or lifecycle actions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      const f = ready()
      const {local, calls} = await simulatedRegistration(directory)
      const prepare = local.prepare
      local.prepare = async (context) => {
        const result = await prepare(context)
        result.routine.definitionDigest = "e".repeat(64)
        return result
      }
      expect((await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)).status).toBe(
        "routine-interrupted",
      )
      expect(calls).toEqual(["verify", "prepare-after-claim"])
      expect(await Bun.file(join(directory, "runs", f.request.requestId, "run.json")).exists()).toBe(false)
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("a failed lifecycle remains a failed test even when preparation returned normally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-request-"))
    try {
      const f = ready()
      const {local, calls} = await simulatedRegistration(directory)
      const prepare = local.prepare
      local.prepare = async (context) => {
        const result = await prepare(context)
        result.routine.finalAssertions[0].observe = async () => ({
          passed: false,
          expected: "target",
          actual: "wrong",
          observedAt: new Date().toISOString(),
          source: "offline simulated failure",
          evidence: ["simulated-failure.json"],
        })
        return result
      }
      const result = await consumeRoutineRequest(f.request, f.evidence, f.trust, directory, local)
      expect(result).toMatchObject({
        status: "routine-finished",
        lifecycle: {test: "failed", outcome: "failed", fixture: "ready"},
      })
      expect(calls.filter((call) => call === "customer-after-intent")).toHaveLength(1)
      expect(await Bun.file(join(directory, "worker-lease.json")).exists()).toBe(false)
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  test("request ZIP extraction rejects duplicate entries, symlinks and extra paths", () => {
    function zip(entries: string[], symlink = false) {
      return execFileSync("python3", [
        "-W",
        "ignore::UserWarning",
        "-c",
        `import io,json,sys,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,"w") as z:
  for name in json.loads(sys.argv[1]):
    i=zipfile.ZipInfo(name)
    if sys.argv[2]=="yes": i.external_attr=(0o120777<<16)
    z.writestr(i,b'{}')
sys.stdout.buffer.write(b.getvalue())`,
        JSON.stringify(entries),
        symlink ? "yes" : "no",
      ])
    }
    expect(Buffer.from(extractRequest(zip(["request.json"]))).toString()).toBe("{}")
    for (const entries of [["request.json", "other"], ["../request.json"], ["request.json", "request.json"]])
      expect(() => extractRequest(zip(entries))).toThrow()
    expect(() => extractRequest(zip(["request.json"], true))).toThrow()
  })
})
