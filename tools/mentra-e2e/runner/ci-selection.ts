import {createHash} from "node:crypto"
import {constants} from "node:fs"
import {mkdir, open} from "node:fs/promises"
import {dirname, isAbsolute, join, normalize} from "node:path"
import {fileURLToPath} from "node:url"
import {verifyBuildManifest} from "./build-manifest"
import {parseRoutineRequest, sha256, type RoutineRequest} from "./ci-request"
import {parseFirmwareProfile, type FirmwareArtifact} from "./firmware-profile"
import {loadLegacyRoute, type FrozenFile, type LegacyRoute} from "./ota-legacy-route"

type Row = Record<string, any>
type FileSource = {path: string; sha256: string; size?: number}
export interface Day1CiCacheIndex {
  schemaVersion: 1
  receipt: string
  archive: string
  otaManifest: string
  returnArtifacts: {asg: string; bes: string; mtk: string}
  /** Operator-reviewed policy/source evidence, already bound to this exact build. */
  legacyRoute: FrozenFile
}
export interface Day1CiSelectionOptions {
  cacheIndex: FrozenFile
  outputDirectory: string
  /** Trusted host executable, never supplied by a CI request. */
  python: string
}
export interface MacCacheVerification {
  packageDirectory: string
  manifest: string
  evidence: string
  observed: {
    bundleId: string
    version: string
    build: string
    executableSha256: string
    javascriptSha256: string
  }
}
export interface Day1CiSelectionServices {
  /** Trusted local implementation only; no function/module name is accepted in JSON. */
  verifyMac(input: {
    python: string
    archive: FrozenFile
    receipt: FrozenFile
    outputDirectory: string
  }): Promise<MacCacheVerification>
}

const hashPattern = /^[a-f\d]{64}$/
const mib = 1024 * 1024
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function object(value: unknown, keys?: string[]): Row {
  requireThat(value && typeof value === "object" && !Array.isArray(value), "Expected cache metadata object")
  requireThat(
    !keys || Object.keys(value).sort().join("|") === [...keys].sort().join("|"),
    "Unexpected cache metadata fields",
  )
  return value as Row
}
function absolute(value: unknown): string {
  requireThat(
    typeof value === "string" && isAbsolute(value) && normalize(value) === value && !/[\0\r\n]/.test(value),
    "Cache paths must be normalized absolute operator paths",
  )
  return value
}
async function checkedFile(source: FileSource, maximum: number): Promise<FrozenFile> {
  const path = absolute(source.path)
  requireThat(hashPattern.test(source.sha256), "Cached artifact requires an exact SHA-256")
  requireThat(
    source.size === undefined || (Number.isSafeInteger(source.size) && source.size > 0),
    "Invalid cached artifact size",
  )
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    requireThat(before.isFile() && before.size > 0 && before.size <= maximum, "Invalid cached artifact type or size")
    const digest = createHash("sha256")
    let size = 0
    for await (const bytes of file.createReadStream({autoClose: false})) {
      size += bytes.length
      requireThat(size <= maximum, "Cached artifact grew beyond its size limit")
      digest.update(bytes)
    }
    const after = await file.stat()
    requireThat(
      before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
      "Cached artifact changed during verification",
    )
    requireThat(
      digest.digest("hex") === source.sha256 && (source.size === undefined || size === source.size),
      "Cached artifact hash or size mismatch",
    )
    return {path, size, sha256: source.sha256}
  } finally {
    await file.close()
  }
}
async function bytes(source: FileSource, maximum: number) {
  const reference = await checkedFile(source, maximum)
  const data = await metadata(reference.path, maximum)
  requireThat(data.length === reference.size && sha256(data) === reference.sha256, "Cached metadata changed")
  return data
}
async function metadata(path: string, maximum: number) {
  const file = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    requireThat(info.isFile() && info.size > 0 && info.size <= maximum, "Invalid bounded metadata file")
    const data = await file.readFile()
    requireThat(data.length <= maximum, "Metadata exceeds its size bound")
    return data
  } finally {
    await file.close()
  }
}
async function save(path: string, data: Uint8Array): Promise<FrozenFile> {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(data)
    await file.sync()
  } finally {
    await file.close()
  }
  const directory = await open(dirname(path), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  return {path, size: data.length, sha256: sha256(data)}
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")

const localServices: Day1CiSelectionServices = {
  async verifyMac(input) {
    const bridge = fileURLToPath(new URL("../verify-ci-selection-mac.py", import.meta.url))
    const argv = [
      input.python,
      bridge,
      "--archive",
      input.archive.path,
      "--sha256",
      input.archive.sha256,
      "--size",
      String(input.archive.size),
      "--receipt",
      input.receipt.path,
      "--output",
      input.outputDirectory,
    ]
    const child = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPYCACHEPREFIX: join(input.outputDirectory, "unused-pycache"),
      },
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await save(join(dirname(input.outputDirectory), "mac-verifier.json"), json({argv, exitCode, stdout, stderr}))
    requireThat(exitCode === 0, "Cached Mac verification failed; inspect private mac-verifier.json")
    requireThat(stdout.length <= mib, "Mac verifier output exceeds its limit")
    return JSON.parse(stdout) as MacCacheVerification
  },
}

/** Caller authenticates RoutineRequest through ci-request before calling this.
 * This cache-only preparation neither claims a request nor selects executable
 * code from it. Large cached artifacts remain hash-pinned references; small
 * metadata is copied into a fresh immutable local selection directory. */
export async function resolveDay1CiSelection(
  input: RoutineRequest,
  options: Day1CiSelectionOptions,
  services: Day1CiSelectionServices = localServices,
) {
  const request = parseRoutineRequest(Buffer.from(JSON.stringify(input)))
  requireThat(
    request.status === "ready" && request.selection,
    "A ready authenticated CI artifact selection is required",
  )
  const selected = request.selection
  const output = absolute(options.outputDirectory)
  absolute(options.python)
  const indexBytes = await bytes(options.cacheIndex, mib)
  const index = object(JSON.parse(indexBytes.toString("utf8")), [
    "schemaVersion",
    "receipt",
    "archive",
    "otaManifest",
    "returnArtifacts",
    "legacyRoute",
  ]) as Day1CiCacheIndex
  requireThat(index.schemaVersion === 1, "Unsupported cache index")
  object(index.returnArtifacts, ["asg", "bes", "mtk"])
  for (const path of [index.receipt, index.archive, index.otaManifest, ...Object.values(index.returnArtifacts)])
    absolute(path)
  const receiptBytes = await bytes({...selected.receipt, path: index.receipt}, mib)
  const receipt = object(JSON.parse(receiptBytes.toString("utf8")))
  // Reuse the publication authority's validator, including schema2 notarization.
  const canonical = await import(new URL("../../../.github/scripts/pr-ios-artifacts.mjs", import.meta.url).href)
  requireThat(receipt.schemaVersion === 2, "This resolver requires canonical schema2 iOS publication metadata")
  canonical.validateIosReceipt(receipt, {
    pr: request.pullRequest.number,
    sha: request.pullRequest.headSha,
    runId: selected.producer.runId,
    attempt: selected.producer.publicationAttempt,
  })
  requireThat(
    (receipt.buildAttempt ?? receipt.runAttempt) === selected.producer.buildAttempt &&
      receipt.buildSha === selected.build.buildSha,
    "Receipt build attempt or revision disagrees with request",
  )
  const app = object(receipt.app)
  requireThat(
    Object.entries(selected.app).every(([key, value]) => app[key] === value),
    "Receipt app differs from authenticated selection",
  )
  requireThat(
    receipt.artifacts.mac.name === selected.archive.name &&
      receipt.artifacts.mac.sha256 === selected.archive.sha256 &&
      receipt.artifacts.mac.size === selected.archive.size,
    "Receipt archive differs from authenticated selection",
  )
  const archive = await checkedFile({...selected.archive, path: index.archive}, 2 * 1024 * mib)
  const manifestBytes = await bytes({...selected.otaManifest, path: index.otaManifest}, 2 * mib)
  const profile = parseFirmwareProfile(manifestBytes, selected.otaManifest)
  const targets = {} as Record<"asg" | "bes" | "mtk", FrozenFile & FirmwareArtifact>
  for (const key of ["asg", "bes", "mtk"] as const) {
    const artifact = profile[key].artifact
    targets[key] = {
      ...artifact,
      ...(await checkedFile({...artifact, path: index.returnArtifacts[key]}, key === "mtk" ? 1024 * mib : 256 * mib)),
    }
  }
  const routeBytes = await bytes(index.legacyRoute, 2 * mib)
  const manifest = object(JSON.parse(manifestBytes.toString("utf8")))
  const route = JSON.parse(routeBytes.toString("utf8")) as LegacyRoute
  const legacy = await loadLegacyRoute(route, {
    buildSha: selected.build.buildSha,
    executableSha256: String(app.executableSha256),
    manifestSha256: selected.otaManifest.sha256,
    manifestUrl: selected.otaManifest.url,
    beforeFirmware: "20260113",
    beforeAsg: 27,
    targetFirmware: profile.mtk.version,
    targetAsg: profile.asg.versionCode,
    targetPatches: manifest.mtk_patches,
  })
  // Check even extra cached evidence before freezing its data references.
  const legacyRefs = [
    route.effectivePolicy,
    ...route.sourceEvidence,
    ...route.manifests,
    ...route.artifacts,
    ...route.embeddedAsg.flatMap((entry) => [entry.artifact, entry.evidence]),
  ]
  for (const reference of legacyRefs) await checkedFile(reference, 1024 * mib)

  await mkdir(output, {mode: 0o700}) // Exclusive: never rewrite a previous selection/failure.
  try {
    const frozenIndex = await save(join(output, "cache-index.json"), indexBytes)
    const frozenReceipt = await save(join(output, "receipt.json"), receiptBytes)
    const frozenManifest = {...selected.otaManifest, ...(await save(join(output, "ota-manifest.json"), manifestBytes))}
    const frozenRoute = await save(join(output, "legacy-route.json"), routeBytes)
    const frozenProfile = await save(join(output, "return-profile.json"), json(profile))
    const mac = await services.verifyMac({
      python: options.python,
      archive,
      receipt: frozenReceipt,
      outputDirectory: join(output, "mac-package"),
    })
    const expectedPackage = join(output, "mac-package", "Mentra PR")
    requireThat(
      mac.packageDirectory === expectedPackage &&
        mac.manifest === join(expectedPackage, "build.json") &&
        mac.evidence === join(output, "mac-package", "verification-commands.json"),
      "Mac verifier returned an unowned path",
    )
    // build.json formatting is producer-owned; its parsed value must equal the receipt.
    const appBytes = await metadata(mac.manifest, mib)
    const packaged = object(JSON.parse(appBytes.toString("utf8")))
    requireThat(
      Object.keys(packaged).length === Object.keys(app).length &&
        Object.entries(app).every(([key, value]) => packaged[key] === value),
      "Packaged build manifest differs from receipt",
    )
    const build = verifyBuildManifest(packaged, mac.observed)
    requireThat(build.verifiedCiBuild, "CI package cannot be reported as a local build")
    const frozenBuild = await save(join(output, "build.json"), appBytes)
    const evidenceBytes = await metadata(mac.evidence, mib)
    const verifiedSignatures = {path: mac.evidence, size: evidenceBytes.length, sha256: sha256(evidenceBytes)}
    // Nothing may change during the slower signature and extraction work.
    for (const ref of [archive, ...Object.values(targets), ...legacyRefs]) await checkedFile(ref, 2 * 1024 * mib)
    await bytes(options.cacheIndex, mib)
    const result = {
      schemaVersion: 1 as const,
      kind: "day1-ci-selection" as const,
      requestId: request.requestId,
      requestSha256: sha256(Buffer.from(JSON.stringify(request))),
      app: {
        manifest: frozenBuild,
        packageDirectory: expectedPackage,
        verifiedCiBuild: packaged,
        compiledSourceCommit: String(build.installedAppCommit),
      },
      otaManifest: frozenManifest,
      returnProfile: profile,
      returnProfileFile: frozenProfile,
      returnArtifacts: targets,
      legacyRoute: frozenRoute,
      allowedFirmware: legacy.allowedFirmware,
      allowedAsg: legacy.allowedAsg,
      evidence: [
        frozenIndex,
        frozenReceipt,
        frozenBuild,
        frozenManifest,
        frozenRoute,
        frozenProfile,
        verifiedSignatures,
      ],
      installed: false as const,
      hardwareStarted: false as const,
      runtimePolicyObserved: false as const,
      firmwareSignatureQualificationIncluded: false as const,
    }
    const reference = await save(join(output, "selection.json"), json(result))
    return {selection: result, reference}
  } catch (error) {
    await save(
      join(output, "failure.json"),
      json({
        status: "failed",
        hardwareStarted: false,
        installed: false,
        message: error instanceof Error ? error.message : "Unknown preparation failure",
      }),
    )
    throw error
  }
}
