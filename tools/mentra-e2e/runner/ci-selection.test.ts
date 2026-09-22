import {expect, test} from "bun:test"
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {resolveDay1CiSelection, type Day1CiSelectionServices} from "./ci-selection"
import {parseRoutineRequest, REQUEST_REPOSITORY, REQUEST_WORKFLOW, sha256} from "./ci-request"
import type {FrozenFile, LegacyRoute} from "./ota-legacy-route"

const head = "a".repeat(40),
  base = "b".repeat(40),
  build = "c".repeat(40)
const cdn = `https://artifactscdn.mentraglass.com/${REQUEST_REPOSITORY}/releases/pr-builds/`
const json = (value: unknown) => Buffer.from(JSON.stringify(value))
async function fixture(body: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "mentra-ci-selection-"))
  try {
    await body(await setup(root))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
}
async function setup(root: string) {
  async function freeze(name: string, value: unknown): Promise<FrozenFile> {
    const bytes = typeof value === "string" ? Buffer.from(value) : json(value)
    const path = join(root, name)
    await writeFile(path, bytes, {mode: 0o600})
    return {path, size: bytes.length, sha256: sha256(bytes)}
  }
  const asg = {...(await freeze("asg.apk", "target-asg")), url: "https://example.test/asg.apk"}
  const bes = {...(await freeze("bes.bin", "target-bes")), url: "https://example.test/bes.bin"}
  const mtk = {...(await freeze("full.zip", "signed-full-target-fixture")), url: "https://example.test/full.zip"}
  const manifest = {
    apps: {"com.mentra.asg_client": {versionCode: 303000001, apkUrl: asg.url, apkSize: asg.size, sha256: asg.sha256}},
    bes_firmware: {url: bes.url, size: bes.size, sha256: bes.sha256, version: "26.9.21.3"},
    mtk_full_ota: {url: mtk.url, size: mtk.size, sha256: mtk.sha256, end_firmware: "20260921.0"},
    mtk_patches: [{start_firmware: "20260709", end_firmware: "20260921.0"}],
  }
  const manifestRef = {...(await freeze("manifest.json", manifest)), url: `${cdn}ota-pr-4136-${head}.json`}
  const app = {
    pr: 4136,
    headSha: head,
    buildSha: build,
    runId: 100,
    runAttempt: 1,
    app: "Mentra.app",
    bundleId: "com.mentra.mentra",
    teamId: "T5XXXL6N36",
    backend: "dev",
    version: "3.3.0",
    build: "303000001",
    executableSha256: sha256(Buffer.from("native")),
    javascriptSha256: sha256(Buffer.from("js")),
    otaManifestUrl: manifestRef.url,
    mobileFingerprint: "d".repeat(64),
    mobileSourceCommit: "e".repeat(40),
    reusedCompilation: true,
    macPackageVersion: 2,
    macInstaller: "Install Mentra.app",
    profileUUID: "12345678-1234-1234-1234-123456789abc",
    profileExpires: "2027-01-01T00:00:00Z",
  }
  const archive = {...(await freeze("mac.zip", "synthetic-archive")), name: `mentra-ios-mac-pr-4136-${head}-100-1.zip`}
  const suffix = `pr-4136-${head}-100-1`
  const receipt = {
    schemaVersion: 2,
    pr: 4136,
    headSha: head,
    buildSha: build,
    runId: 100,
    runAttempt: 2,
    buildAttempt: 1,
    app,
    macInstaller: {
      bundleId: "com.mentra.mac-installer",
      teamId: "T5XXXL6N36",
      notarizationStatus: "Accepted",
      stapled: true,
      notarizationId: "12345678-1234-1234-1234-123456789abc",
    },
    artifacts: {
      mac: {name: archive.name, size: archive.size, sha256: archive.sha256},
      iphone: {name: `mentra-ios-iphone-${suffix}.ipa`, size: 1, sha256: "1".repeat(64)},
      manifest: {name: `mentra-ios-manifest-${suffix}.plist`, size: 1, sha256: "2".repeat(64)},
      install: {name: `mentra-ios-install-${suffix}.html`, size: 1, sha256: "3".repeat(64)},
    },
  }
  const receiptRef = {...(await freeze("receipt.json", receipt)), url: `${cdn}mentra-ios-pr-4136-${head}-100-2.json`}
  const {app: _appName, ...requestApp} = app
  const request = parseRoutineRequest(
    json({
      schemaVersion: 1,
      kind: "mentra-routine-request",
      requestId: "routine-200-1-4136-day1-ota",
      createdAt: "2026-09-22T00:00:00Z",
      status: "ready",
      reason: "Published exact build",
      trigger: {
        kind: "pull_request",
        repository: REQUEST_REPOSITORY,
        workflow: REQUEST_WORKFLOW,
        runId: 200,
        runAttempt: 1,
        ref: "refs/pull/4136/merge",
        sha: build,
        workflowSha: build,
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
      routine: {id: "day1-ota", reason: "Requested", harnessRevision: build},
      attempts: [],
      selection: {
        platform: "ios-on-mac",
        producer: {
          workflow: ".github/workflows/mentra-app-ios-build.yml",
          runId: 100,
          buildAttempt: 1,
          publicationAttempt: 2,
          url: `https://github.com/${REQUEST_REPOSITORY}/actions/runs/100`,
        },
        receipt: {url: receiptRef.url, size: receiptRef.size, sha256: receiptRef.sha256},
        archive: {url: cdn + archive.name, name: archive.name, size: archive.size, sha256: archive.sha256},
        otaManifest: {url: manifestRef.url, size: manifestRef.size, sha256: manifestRef.sha256},
        app: requestApp,
        build: {headSha: head, baseSha: base, buildSha: build},
      },
    }),
  )
  const asg31 = {...(await freeze("asg31.apk", "legacy-asg31")), url: "https://example.test/31.apk"}
  const patch = {...(await freeze("jan-july.zip", "legacy-jan-july")), url: "https://example.test/jan-july.zip"}
  const source = await freeze("reviewed-source.txt", "reviewed exact compiled policy")
  const route: LegacyRoute = {
    schemaVersion: 1,
    buildSha: build,
    executableSha256: app.executableSha256,
    manifestSha256: manifestRef.sha256,
    effectivePolicy: await freeze("policy.json", {
      buildSha: build,
      executableSha256: app.executableSha256,
      manifestUrl: manifestRef.url,
      allowLegacyOtaFallback: true,
      modernOverride: null,
    }),
    sourceEvidence: [source],
    manifests: [
      {
        ...(await freeze("legacy.json", {
          versionCode: 31,
          apkUrl: asg31.url,
          sha256: asg31.sha256,
          mtk_patches: [{start_firmware: "20260113", end_firmware: "20260709", url: patch.url, sha256: patch.sha256}],
        })),
        url: "https://example.test/legacy.json",
      },
    ],
    artifacts: [asg31, patch],
    embeddedAsg: [
      {firmware: "20260709", versionCode: 39, artifact: await freeze("asg39.apk", "system-asg39"), evidence: source},
    ],
  }
  const routeRef = await freeze("route.json", route)
  const index = {
    schemaVersion: 1,
    receipt: receiptRef.path,
    archive: archive.path,
    otaManifest: manifestRef.path,
    returnArtifacts: {asg: asg.path, bes: bes.path, mtk: mtk.path},
    legacyRoute: routeRef,
  }
  const options = {
    cacheIndex: await freeze("cache-index.json", index),
    outputDirectory: join(root, "selection"),
    python: Bun.which("python3")!,
  }
  let verifierCalls = 0
  const services: Day1CiSelectionServices = {
    async verifyMac(input) {
      verifierCalls++
      const packageDirectory = join(input.outputDirectory, "Mentra PR")
      await mkdir(packageDirectory, {recursive: true, mode: 0o700})
      const packaged = JSON.parse(await readFile(input.receipt.path, "utf8")).app
      const manifest = join(packageDirectory, "build.json"),
        evidence = join(input.outputDirectory, "verification-commands.json")
      await writeFile(manifest, JSON.stringify(packaged), {mode: 0o600})
      await writeFile(evidence, JSON.stringify([{argv: ["codesign", "--verify"], exitCode: 0}]), {mode: 0o600})
      return {
        packageDirectory,
        manifest,
        evidence,
        observed: {
          bundleId: app.bundleId,
          version: app.version,
          build: app.build,
          executableSha256: app.executableSha256,
          javascriptSha256: app.javascriptSha256,
        },
      }
    },
  }
  return {
    root,
    freeze,
    app,
    request,
    receipt,
    receiptRef,
    archive,
    manifest,
    manifestRef,
    route,
    routeRef,
    index,
    options,
    asg,
    mtk,
    services,
    calls: () => verifierCalls,
  }
}

test("freeze canonical republished CI selection and exact cached route without claiming runtime or firmware qualification", async () => {
  await fixture(async (f) => {
    const result = await resolveDay1CiSelection(f.request, f.options, f.services)
    expect(f.calls()).toBe(1)
    expect(result.selection.app.compiledSourceCommit).toBe(f.app.mobileSourceCommit)
    expect(result.selection.app.verifiedCiBuild).toEqual(f.app)
    expect(result.selection.returnArtifacts.mtk.sha256).toBe(f.mtk.sha256)
    expect(result.selection.allowedFirmware).toEqual([
      "MentraLive_20260113",
      "MentraLive_20260709",
      "MentraLive_20260921.0",
    ])
    expect(result.selection.allowedAsg).toEqual([27, 303000001, 31, 39])
    expect(result.selection.runtimePolicyObserved).toBe(false)
    expect(result.selection.firmwareSignatureQualificationIncluded).toBe(false)
    expect(result.selection.installed).toBe(false)
    expect(result.selection.hardwareStarted).toBe(false)
    expect(sha256(await readFile(result.reference.path))).toBe(result.reference.sha256)
    expect((await stat(result.reference.path)).mode & 0o777).toBe(0o600)
    await expect(resolveDay1CiSelection(f.request, f.options, f.services)).rejects.toThrow()
    expect(f.calls()).toBe(1)
  })
})
test("changed cached bytes and missing return full image reject before Mac extraction", async () => {
  for (const key of ["archive", "asg", "mtk"] as const)
    await fixture(async (f) => {
      await writeFile(f[key].path, "changed")
      await expect(resolveDay1CiSelection(f.request, f.options, f.services)).rejects.toThrow("hash or size")
      expect(f.calls()).toBe(0)
    })
})
test("canonical schema2 notarization and request publication/build attempts remain mandatory", async () => {
  for (const mutate of [
    (r: any) => (r.macInstaller.stapled = false),
    (r: any) => (r.buildAttempt = 2),
    (r: any) => (r.schemaVersion = 1),
    (r: any) => (r.app.javascriptSha256 = "f".repeat(64)),
  ]) {
    await fixture(async (f) => {
      mutate(f.receipt)
      const updated = await f.freeze("receipt.json", f.receipt)
      f.request.selection!.receipt = {...f.request.selection!.receipt, sha256: updated.sha256, size: updated.size}
      await expect(resolveDay1CiSelection(f.request, f.options, f.services)).rejects.toThrow()
      expect(f.calls()).toBe(0)
    })
  }
})
test("another build's legacy policy and tampered source evidence cannot be repackaged as reviewed", async () => {
  await fixture(async (f) => {
    await writeFile(f.route.sourceEvidence[0].path, "changed")
    await expect(resolveDay1CiSelection(f.request, f.options, f.services)).rejects.toThrow("Frozen file changed")
    expect(f.calls()).toBe(0)
  })
  await fixture(async (f) => {
    f.route.buildSha = "f".repeat(40)
    f.index.legacyRoute = await f.freeze("route.json", f.route)
    f.options.cacheIndex = await f.freeze("cache-index.json", f.index)
    await expect(resolveDay1CiSelection(f.request, f.options, f.services)).rejects.toThrow("another selected")
  })
})
test("signature failure and artifact mutation during verification preserve failure and omit terminal selection", async () => {
  for (const corrupt of [false, true])
    await fixture(async (f) => {
      const verify = f.services.verifyMac
      f.services.verifyMac = async (input) => {
        if (!corrupt) throw new Error("signature verification failed")
        const result = await verify(input)
        await writeFile(f.asg.path, "changed")
        return result
      }
      await expect(resolveDay1CiSelection(f.request, f.options, f.services)).rejects.toThrow()
      const files = await readdir(f.options.outputDirectory)
      expect(files).toContain("failure.json")
      expect(files).not.toContain("selection.json")
    })
})
test("unknown operator cache fields and no-artifact requests cannot supply a new executable or imply readiness", async () => {
  await fixture(async (f) => {
    f.options.cacheIndex = await f.freeze("cache-index.json", {...f.index, command: "run untrusted code"})
    await expect(resolveDay1CiSelection(f.request, f.options, f.services)).rejects.toThrow("metadata fields")
    expect(f.calls()).toBe(0)
    f.request.status = "no-artifact"
    f.request.selection = null
    await expect(resolveDay1CiSelection(f.request, f.options, f.services)).rejects.toThrow("ready authenticated")
  })
})
