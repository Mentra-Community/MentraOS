import {expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {publishTestRun, type PublishTestRunOptions} from "./test-run-publisher"
import {
  canonicalJson,
  mapCiIntakeResult,
  MAX_ASSET_BYTES,
  MAX_METADATA_BYTES,
  parsePublicationMetadata,
  type PublicationMetadata,
} from "./test-run-record"
import type {RoutineRequest} from "./ci-request"

const TOKEN = "test-token-for-loopback-only-123456789"
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const video = Buffer.from("000000006674797069736f6d", "hex")
const log = Buffer.from("Synthetic test log. No hardware ran.\n")
function record() {
  return {
    runId: "synthetic-run",
    requestId: "synthetic-request",
    routineId: "day1-ota",
    routineVersion: "1",
    platform: "ios-mac",
    channel: "pr",
    prNumber: 4136,
    startedAt: "2026-09-21T12:00:00Z",
    finishedAt: "2026-09-21T12:00:10Z",
    outcome: "failed",
    outcomes: {test: "failed", teardown: "passed", fixture: "ready", evidence: "complete"},
    provenance: {repository: "Mentra-Community/MentraOS", headSha: "a".repeat(40)},
    fixture: {alias: "synthetic"},
    firmwareAssertions: [{component: "BES", expected: "1.0", actual: "0.9", status: "failed"}],
    chapters: [
      {
        id: "verify",
        instruction: "Verify firmware",
        status: "failed",
        phase: "verify",
        videoAssetId: "video",
        videoStart: 2,
        videoEnd: 5,
      },
    ],
    assets: [
      {
        assetId: "video",
        kind: "video",
        contentType: "video/mp4",
        filename: "video.mp4",
        sizeBytes: video.length,
        sha256: sha(video),
      },
      {
        assetId: "log",
        kind: "log",
        contentType: "text/plain",
        filename: "run.txt",
        sizeBytes: log.length,
        sha256: sha(log),
      },
    ],
  }
}

async function fixture(
  action: (options: PublishTestRunOptions, run: ReturnType<typeof record>, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "test-run-publisher-"))
  const run = record()
  await writeFile(join(root, "run.json"), JSON.stringify(run))
  await writeFile(
    join(root, "assets.json"),
    JSON.stringify({
      schemaVersion: 1,
      assets: [
        {assetId: "video", path: "video.mp4"},
        {assetId: "log", path: "run.txt"},
      ],
    }),
  )
  await writeFile(join(root, "video.mp4"), video)
  await writeFile(join(root, "run.txt"), log)
  try {
    await action(
      {
        metadataPath: join(root, "run.json"),
        assetsPath: join(root, "assets.json"),
        evidenceRoot: root,
        journalPath: join(root, "upload.jsonl"),
        coreUrl: "http://127.0.0.1:1",
        adminUrl: "https://admin.example.invalid",
        token: TOKEN,
      },
      run,
      root,
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
}

function endpoint(
  options: {loseFirstAck?: boolean; wrongReportPath?: boolean; afterFirstPost?: () => Promise<void>} = {},
) {
  const uploaded = new Map<string, Buffer>()
  const requests: {method: string; pathname: string}[] = []
  let payload: PublicationMetadata | undefined
  let lostAck = false
  let posted = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      requests.push({method: request.method, pathname})
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`)
        return new Response(`Forbidden token: ${request.headers.get("authorization")}`, {status: 401})
      if (request.method === "POST" && pathname === "/api/internal/test-runs") {
        const input = parsePublicationMetadata(await request.json())
        if (payload && canonicalJson(payload) !== canonicalJson(input))
          return new Response("immutable conflict", {status: 409})
        const created = !payload
        payload = input
        if (!posted) {
          posted = true
          await options.afterFirstPost?.()
        }
        return Response.json(
          {
            runId: input.runId,
            created,
            payloadSha256: sha(canonicalJson(input)),
            reportPath: options.wrongReportPath ? "https://attacker.invalid/token" : `/?testRun=${input.runId}`,
            missingAssetIds: input.assets.filter((asset) => !uploaded.has(asset.assetId)).map((asset) => asset.assetId),
          },
          {status: created ? 201 : 200},
        )
      }
      if (request.method === "PUT" && payload) {
        const assetId = pathname.split("/").at(-1)!
        const asset = payload.assets.find((asset) => asset.assetId === assetId)
        if (!asset || pathname !== `/api/internal/test-runs/${payload.runId}/assets/${assetId}`)
          return new Response("not found", {status: 404})
        const bytes = Buffer.from(await request.arrayBuffer())
        if (
          request.headers.get("content-type") !== asset.contentType ||
          bytes.length !== asset.sizeBytes ||
          sha(bytes) !== asset.sha256
        )
          return new Response("invalid bytes", {status: 400})
        const created = !uploaded.has(assetId)
        uploaded.set(assetId, bytes)
        if (options.loseFirstAck && !lostAck) {
          lostAck = true
          return new Response("lost acknowledgement", {status: 503})
        }
        return Response.json({assetId, uploaded: true, created}, {status: created ? 201 : 200})
      }
      return new Response("not found", {status: 404})
    },
  })
  return {url: server.url.origin, requests, uploaded, payload: () => payload, stop: () => server.stop(true)}
}

test("lost upload acknowledgement reconciles from server state; repeat never changes the source verdict", async () =>
  fixture(async (options, run) => {
    const server = endpoint({loseFirstAck: true})
    options.coreUrl = server.url
    try {
      await expect(publishTestRun(options)).rejects.toThrow("HTTP 503")
      expect(server.uploaded.has("video")).toBe(true)
      const before = await readFile(options.journalPath, "utf8")
      const result = await publishTestRun(options)
      expect(result).toEqual({
        runId: run.runId,
        reportUrl: "https://admin.example.invalid/?testRun=synthetic-run",
        publication: "complete",
        uploadedAssets: 1,
        sourceOutcome: "failed",
        sourceEvidence: "complete",
      })
      expect((await readFile(options.journalPath, "utf8")).startsWith(before)).toBe(true)
      expect(
        server.requests
          .filter((request) => request.method === "PUT")
          .map((request) => request.pathname.split("/").at(-1)),
      ).toEqual(["video", "log"])
      expect(server.uploaded.get("log")).toEqual(log)
      expect(server.payload() as unknown).toEqual(run)
      expect((await publishTestRun(options)).uploadedAssets).toBe(0)
      expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(2)
      const journal = await readFile(options.journalPath, "utf8")
      expect(journal).toContain('"event":"asset-intent"')
      expect(journal).toContain('"event":"publication-interrupted"')
      expect(journal).not.toContain(TOKEN)
      expect((await stat(options.journalPath)).mode & 0o777).toBe(0o600)
    } finally {
      server.stop()
    }
  }))

test("digest mismatch, invalid media and oversized metadata stop before any request", async () =>
  fixture(async (options, run, root) => {
    const server = endpoint()
    options.coreUrl = server.url
    try {
      await writeFile(join(root, "run.txt"), Buffer.alloc(log.length, 1))
      await expect(publishTestRun(options)).rejects.toThrow("SHA-256")
      expect(server.requests).toHaveLength(0)
      expect(await Bun.file(options.journalPath).exists()).toBe(false)
      await writeFile(join(root, "run.txt"), log)
      const invalid = Buffer.alloc(video.length)
      await writeFile(join(root, "video.mp4"), invalid)
      run.assets[0].sha256 = sha(invalid)
      await writeFile(options.metadataPath, JSON.stringify(run))
      await expect(publishTestRun(options)).rejects.toThrow("media format")
      await writeFile(options.metadataPath, Buffer.alloc(MAX_METADATA_BYTES + 1))
      await expect(publishTestRun(options)).rejects.toThrow("size limit")
      expect(server.requests).toHaveLength(0)
    } finally {
      server.stop()
    }
  }))

test("an asset changed after metadata acknowledgement is never uploaded", async () =>
  fixture(async (options, _run, root) => {
    const server = endpoint({afterFirstPost: () => writeFile(join(root, "video.mp4"), Buffer.alloc(video.length))})
    options.coreUrl = server.url
    try {
      await expect(publishTestRun(options)).rejects.toThrow("SHA-256")
      expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(0)
    } finally {
      server.stop()
    }
  }))

test("only explicitly enumerated files under the evidence root can be published", async () =>
  fixture(async (options, _run, root) => {
    for (const path of ["../run.txt", "/etc/passwd", "./run.txt", "nested/../run.txt", "nested\\run.txt"]) {
      await writeFile(
        options.assetsPath,
        JSON.stringify({
          schemaVersion: 1,
          assets: [
            {assetId: "video", path},
            {assetId: "log", path: "run.txt"},
          ],
        }),
      )
      await expect(publishTestRun(options)).rejects.toThrow("relative path")
    }
    await symlink(join(root, "video.mp4"), join(root, "linked.mp4"))
    await writeFile(
      options.assetsPath,
      JSON.stringify({
        schemaVersion: 1,
        assets: [
          {assetId: "video", path: "linked.mp4"},
          {assetId: "log", path: "run.txt"},
        ],
      }),
    )
    await expect(publishTestRun(options)).rejects.toThrow("symlink")
    await mkdir(join(root, "media"))
    await writeFile(join(root, "media", "video.mp4"), video)
    await symlink(join(root, "media"), join(root, "linked-directory"))
    await writeFile(
      options.assetsPath,
      JSON.stringify({
        schemaVersion: 1,
        assets: [
          {assetId: "video", path: "linked-directory/video.mp4"},
          {assetId: "log", path: "run.txt"},
        ],
      }),
    )
    await expect(publishTestRun(options)).rejects.toThrow("symlink")
    await writeFile(options.assetsPath, JSON.stringify({schemaVersion: 1, assets: []}))
    await expect(publishTestRun(options)).rejects.toThrow("enumerate every")
  }))

test("wrong token is reported without body reflection or token disclosure in CLI output or journal", async () =>
  fixture(async (options) => {
    const server = endpoint()
    const wrong = "wrong-secret-token-should-never-be-output"
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("../publish-test-run.ts", import.meta.url).pathname,
          "--run",
          options.metadataPath,
          "--assets",
          options.assetsPath,
          "--evidence-root",
          options.evidenceRoot,
          "--journal",
          options.journalPath,
        ],
        {
          env: {
            ...process.env,
            MENTRA_E2E_CORE_URL: server.url,
            MENTRA_E2E_ADMIN_URL: options.adminUrl,
            TEST_RUN_INGEST_TOKEN: wrong,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(1)
      expect(stderr).toContain("HTTP 401")
      expect(stdout + stderr + (await readFile(options.journalPath, "utf8"))).not.toContain(wrong)
      expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(0)
    } finally {
      server.stop()
    }
  }))

test("journal identity and acknowledgement checks prevent changing an immutable selection", async () =>
  fixture(async (options, run) => {
    const server = endpoint()
    options.coreUrl = server.url
    try {
      await publishTestRun(options)
      const before = await readFile(options.journalPath, "utf8")
      const count = server.requests.length
      Object.assign(run, {notes: "different metadata"})
      await writeFile(options.metadataPath, JSON.stringify(run))
      await expect(publishTestRun(options)).rejects.toThrow("different immutable publication")
      expect(server.requests).toHaveLength(count)
      expect(await readFile(options.journalPath, "utf8")).toBe(before)
    } finally {
      server.stop()
    }
  }))

test("external report URLs, redirects and non-HTTPS endpoints are rejected", async () =>
  fixture(async (options) => {
    const server = endpoint({wrongReportPath: true})
    options.coreUrl = server.url
    try {
      await expect(publishTestRun(options)).rejects.toThrow("acknowledgement does not match")
      expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(0)
    } finally {
      server.stop()
    }
    for (const coreUrl of [
      "http://example.invalid",
      "https://user:password@example.invalid",
      "https://example.invalid/private",
      "https://example.invalid?token=secret",
    ]) {
      await expect(publishTestRun({...options, coreUrl})).rejects.toThrow("HTTPS origin")
    }
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect("http://127.0.0.1:1/steal", 307),
    })
    try {
      await expect(
        publishTestRun({...options, coreUrl: redirect.url.origin, journalPath: options.journalPath + "-redirect"}),
      ).rejects.toThrow("request failed")
    } finally {
      redirect.stop(true)
    }
  }))

test("transport preflight rejects unsafe types, sizes, IDs and duplicate assets", () => {
  const mutations: ((run: any) => void)[] = [
    (run) => {
      run.assets[0].contentType = "text/html"
    },
    (run) => {
      run.assets[0].sizeBytes = MAX_ASSET_BYTES + 1
    },
    (run) => {
      run.assets[0].assetId = "../secret"
    },
    (run) => {
      run.assets.push(run.assets[0])
    },
    (run) => {
      run.runId = "../secret"
    },
    (run) => {
      run.assets[0].sha256 = "a"
    },
  ]
  for (const mutate of mutations) {
    const run = record()
    mutate(run)
    expect(() => parsePublicationMetadata(run)).toThrow()
  }
  // General schema and truthful verdict validation deliberately belong to the backend.
  const contradictory = {...record(), outcome: "passed", unrecognizedField: "backend must reject"}
  expect(parsePublicationMetadata(contradictory) as unknown).toEqual(contradictory)
})

test("server schema rejection stops before any asset upload", async () =>
  fixture(async (options, run) => {
    run.outcome = "passed" // Contradicts the failure assertions; transport preflight is not full validation.
    await writeFile(options.metadataPath, JSON.stringify(run))
    let putCount = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.method === "PUT") putCount++
        return Response.json({error: "invalid result"}, {status: 400})
      },
    })
    try {
      await expect(publishTestRun({...options, coreUrl: server.url.origin})).rejects.toThrow("HTTP 400")
      expect(putCount).toBe(0)
    } finally {
      server.stop(true)
    }
  }))

function noArtifactRequest(): RoutineRequest {
  const workflow = ".github/workflows/request-e2e-routine.yml"
  return {
    schemaVersion: 1,
    kind: "mentra-routine-request",
    requestId: "routine-100-1-4136-day1-ota",
    createdAt: "2026-09-21T12:00:00Z",
    status: "no-artifact",
    reason: "No matching Mac artifact",
    trigger: {
      kind: "pull_request",
      repository: "Mentra-Community/MentraOS",
      workflow,
      runId: 100,
      runAttempt: 1,
      ref: "refs/pull/4136/merge",
      sha: "a".repeat(40),
      workflowSha: "a".repeat(40),
      workflowRef: `Mentra-Community/MentraOS/${workflow}@refs/pull/4136/merge`,
      actor: "synthetic",
    },
    pullRequest: {
      number: 4136,
      url: "https://github.com/Mentra-Community/MentraOS/pull/4136",
      headSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      headRepository: "Mentra-Community/MentraOS",
      baseRef: "dev",
    },
    routine: {id: "day1-ota", reason: "Requested", harnessRevision: "a".repeat(40)},
    selection: null,
    attempts: [],
  }
}

test("original CI intake metadata uses actual times and revisions without inventing hardware evidence", async () =>
  fixture(async (options) => {
    const request = noArtifactRequest()
    const result = {
      schemaVersion: 1,
      requestId: request.requestId,
      status: "no-artifact",
      reason: "No candidate published",
      hardwareStarted: false,
      at: "2026-09-21T12:02:00Z",
    }
    const metadata = {startedAt: "2026-09-21T12:01:00Z", routineVersion: "intake-v1", harnessSha: "d".repeat(40)}
    const run = mapCiIntakeResult(request, result, metadata)
    expect(run.outcome).toBe("blocked")
    expect(run.outcomes).toEqual({test: "not-run", teardown: "not-run", fixture: "unknown", evidence: "complete"})
    expect(run.startedAt).toBe(metadata.startedAt)
    expect(run.finishedAt).toBe(result.at)
    expect(run.provenance.headSha).toBe(request.pullRequest.headSha)
    expect(run.provenance.harnessSha).toBe(metadata.harnessSha)
    expect(run.fixture.alias).toBe("unallocated")
    expect(run.assets).toEqual([])
    expect(run.notes).toContain("No device operation ran")
    for (const changed of [
      {...result, status: "already-claimed"},
      {...result, requestId: "other"},
      {...result, hardwareStarted: true},
      {...result, status: "blocked-unqualified"},
    ])
      expect(() => mapCiIntakeResult(request, changed, metadata)).toThrow()
    const server = endpoint()
    try {
      await writeFile(options.metadataPath, JSON.stringify(run))
      await writeFile(options.assetsPath, JSON.stringify({schemaVersion: 1, assets: []}))
      const published = await publishTestRun({...options, coreUrl: server.url})
      expect(published.publication).toBe("complete")
      expect(published.sourceOutcome).toBe("blocked")
      expect(published.uploadedAssets).toBe(0)
    } finally {
      server.stop()
    }
  }))

test("selected but unqualified CI intake preserves the exact build and manifest provenance", () => {
  const request = noArtifactRequest()
  const head = request.pullRequest.headSha
  const buildSha = "e".repeat(40)
  const digest = "f".repeat(64)
  const cdn = "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/"
  const archiveName = `mentra-ios-mac-pr-4136-${head}-200-1.zip`
  const manifestUrl = `${cdn}ota-pr-4136-${head}.json`
  request.status = "ready"
  request.selection = {
    platform: "ios-on-mac",
    producer: {
      workflow: ".github/workflows/mentra-app-ios-build.yml",
      runId: 200,
      buildAttempt: 1,
      publicationAttempt: 2,
      url: "https://github.com/Mentra-Community/MentraOS/actions/runs/200",
    },
    receipt: {url: `${cdn}mentra-ios-pr-4136-${head}-200-2.json`, sha256: digest, size: 1000},
    archive: {url: cdn + archiveName, name: archiveName, sha256: digest, size: 10000},
    otaManifest: {url: manifestUrl, sha256: digest, size: 1000},
    app: {
      pr: 4136,
      headSha: head,
      buildSha,
      runId: 200,
      runAttempt: 1,
      bundleId: "com.mentra.mentra",
      teamId: "T5XXXL6N36",
      backend: "dev",
      version: "3.2.1",
      build: "302010030",
      executableSha256: digest,
      javascriptSha256: digest,
      otaManifestUrl: manifestUrl,
    },
    build: {headSha: head, baseSha: request.pullRequest.baseSha, buildSha},
  }
  const run = mapCiIntakeResult(
    request,
    {
      schemaVersion: 1,
      requestId: request.requestId,
      status: "blocked-unqualified",
      hardwareStarted: false,
      reason: "Fixture is not qualified",
      at: "2026-09-21T12:02:00Z",
    },
    {startedAt: "2026-09-21T12:01:00Z", routineVersion: "intake-v1", harnessSha: "d".repeat(40)},
  )
  expect(run.outcome).toBe("blocked")
  expect(run.outcomes.test).toBe("not-run")
  expect(run.provenance.buildSha).toBe(buildSha)
  expect(run.provenance.manifestSha256).toBe(digest)
  expect(run.provenance.producerUrl).toBe(request.selection.producer.url)
  expect(run.firmwareAssertions).toEqual([])
})
