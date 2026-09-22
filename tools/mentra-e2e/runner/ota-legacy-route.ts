import {createHash} from "node:crypto"
import {createReadStream} from "node:fs"
import {readFile} from "node:fs/promises"
import {isAbsolute} from "node:path"
import {normalizeFirmware, otaFirmwareRoute} from "./ota-state"
import type {Check} from "./suite"

export type FrozenFile = {path: string; sha256: string; size: number}
export type FrozenManifest = FrozenFile & {url: string}
export type LegacyRouteSelection = {
  buildSha: string
  executableSha256: string
  manifestSha256: string
  manifestUrl: string
  beforeFirmware: string
  beforeAsg: number
  targetFirmware: string
  targetAsg: number
  targetPatches?: {start_firmware: string; end_firmware: string}[]
}
export type LegacyRoute = {
  schemaVersion: 1
  buildSha: string
  executableSha256: string
  manifestSha256: string
  effectivePolicy: FrozenFile
  sourceEvidence: FrozenFile[]
  manifests: FrozenManifest[]
  artifacts: (FrozenFile & {url: string})[]
  /** A system APK exposed by an MTK handoff needs separate reviewed evidence. */
  embeddedAsg: {firmware: string; versionCode: number; artifact: FrozenFile; evidence: FrozenFile}[]
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a legacy route object")
  return value as Record<string, any>
}
function file(value: unknown): FrozenFile {
  const row = record(value)
  if (
    !isAbsolute(row.path ?? "") ||
    !/^[a-f0-9]{64}$/.test(row.sha256 ?? "") ||
    !Number.isSafeInteger(row.size) ||
    row.size <= 0
  )
    throw new Error("Legacy route files need absolute paths, sizes and SHA-256")
  return row as FrozenFile
}
function https(value: unknown): string {
  if (typeof value !== "string") throw new Error("Legacy route needs HTTPS URLs")
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid legacy URL")
  return url.href
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("Invalid legacy ASG version")
  return Number(value)
}

/** Hash existing artifacts without loading firmware images into memory. */
export async function verifyFrozenFile(reference: FrozenFile) {
  file(reference)
  const hash = createHash("sha256")
  let size = 0
  for await (const part of createReadStream(reference.path)) {
    hash.update(part)
    size += part.length
  }
  if (size !== reference.size || hash.digest("hex") !== reference.sha256)
    throw new Error(`Frozen file changed: ${reference.path}`)
}
async function readFrozenJson(reference: FrozenFile) {
  file(reference)
  if (reference.size > 2 * 1024 * 1024) throw new Error("Legacy route metadata exceeds 2 MiB")
  const bytes = await readFile(reference.path)
  if (bytes.length !== reference.size || digest(bytes) !== reference.sha256)
    throw new Error(`Frozen metadata changed: ${reference.path}`)
  return record(JSON.parse(bytes.toString("utf8")))
}

/** Re-read mutable rescue endpoints before dispatch and final acceptance. No firmware download. */
export async function verifyPublishedLegacyManifests(manifests: FrozenManifest[], request: typeof fetch = fetch) {
  for (const manifest of manifests) {
    const response = await request(https(manifest.url), {signal: AbortSignal.timeout(20000)})
    if (!response.ok) throw new Error(`Legacy manifest unavailable: HTTP ${response.status}`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Legacy manifest has no body")
    let size = 0
    const hash = createHash("sha256")
    try {
      for (;;) {
        const {done, value} = await reader.read()
        if (done) break
        size += value.length
        if (size > manifest.size) throw new Error("Published legacy manifest size changed")
        hash.update(value)
      }
    } finally {
      await reader.cancel()
    }
    if (size !== manifest.size || hash.digest("hex") !== manifest.sha256)
      throw new Error("Published legacy manifest differs from the frozen route")
  }
}

/** This checks reviewed input integrity, not the truth of an operator's policy audit.
 * The caller must obtain policy evidence from the selected app and source/binary
 * investigation. No arbitrary executable, command or module is accepted here. */
export async function loadLegacyRoute(input: unknown, selected: LegacyRouteSelection) {
  const route = record(input) as LegacyRoute
  if (
    !/^[a-f0-9]{40}$/.test(selected.buildSha ?? "") ||
    !/^[a-f0-9]{64}$/.test(selected.executableSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(selected.manifestSha256 ?? "")
  )
    throw new Error("Legacy replay requires exact selected build and artifact digests")
  https(selected.manifestUrl)
  if (
    route.schemaVersion !== 1 ||
    route.buildSha !== selected.buildSha ||
    route.executableSha256 !== selected.executableSha256 ||
    route.manifestSha256 !== selected.manifestSha256
  )
    throw new Error("Legacy route belongs to another selected build or manifest")
  if (
    !Array.isArray(route.sourceEvidence) ||
    !route.sourceEvidence.length ||
    !Array.isArray(route.manifests) ||
    !route.manifests.length ||
    route.manifests.length > 8 ||
    !Array.isArray(route.artifacts) ||
    !Array.isArray(route.embeddedAsg)
  )
    throw new Error("Legacy route needs reviewed policy/source evidence and bounded manifests")
  const policy = await readFrozenJson(route.effectivePolicy)
  if (
    policy.buildSha !== selected.buildSha ||
    policy.executableSha256 !== selected.executableSha256 ||
    policy.manifestUrl !== selected.manifestUrl ||
    policy.allowLegacyOtaFallback !== true ||
    policy.modernOverride !== null
  )
    throw new Error("Selected app policy does not permit this legacy route and final pin")
  for (const source of route.sourceEvidence) await verifyFrozenFile(source)
  const manifests = []
  const urls = new Set<string>()
  for (const manifest of route.manifests) {
    const url = https(manifest.url)
    if (urls.has(url)) throw new Error("Duplicate legacy manifest URL")
    urls.add(url)
    manifests.push(await readFrozenJson(manifest))
  }
  const patches = manifests.flatMap((manifest) => {
    if (manifest.mtk_patches === undefined) return []
    if (!Array.isArray(manifest.mtk_patches)) throw new Error("Malformed legacy MTK patches")
    return manifest.mtk_patches.map((value: unknown) => {
      const patch = record(value)
      return {
        url: patch.url,
        sha256: patch.sha256,
        size: patch.size,
        start_firmware: normalizeFirmware(patch.start_firmware),
        end_firmware: normalizeFirmware(patch.end_firmware),
      }
    })
  })
  const allowedFirmware = otaFirmwareRoute(selected.beforeFirmware, selected.targetFirmware, [
    ...patches,
    ...(selected.targetPatches ?? []),
  ])
  const allowedAsg = new Set([version(selected.beforeAsg), version(selected.targetAsg)])
  const needed: {url: string; sha256: string; size?: number}[] = []
  for (const manifest of manifests) {
    // January's first endpoint is a flat ASG descriptor; later feeds are multi-component.
    const asg = record(manifest.apps?.["com.mentra.asg_client"] ?? manifest)
    allowedAsg.add(version(asg.versionCode))
    needed.push({url: https(asg.apkUrl), sha256: asg.sha256, size: asg.apkSize})
    if (manifest.bes_firmware) {
      const bes = record(manifest.bes_firmware)
      needed.push({url: https(bes.url), sha256: bes.sha256, size: bes.size})
    }
  }
  // Require only selected route patches, never unrelated branches in the rescue feed.
  for (let i = 0; i < allowedFirmware.length - 1; i++) {
    const patch = patches.find((entry) => normalizeFirmware(entry.start_firmware) === allowedFirmware[i])
    if (patch) needed.push({url: https(patch.url), sha256: patch.sha256, size: patch.size})
  }
  for (const expected of needed) {
    if (!/^[a-f0-9]{64}$/.test(expected.sha256 ?? "")) throw new Error("Legacy manifest artifact lacks SHA-256")
    const matches = route.artifacts.filter((artifact) => artifact.url === expected.url)
    if (
      matches.length !== 1 ||
      matches[0].sha256 !== expected.sha256 ||
      (expected.size !== undefined && matches[0].size !== expected.size)
    )
      throw new Error("Missing or mismatched cached legacy artifact")
    await verifyFrozenFile(matches[0])
  }
  for (const embedded of route.embeddedAsg) {
    if (!allowedFirmware.includes(normalizeFirmware(embedded.firmware)))
      throw new Error("Embedded ASG is outside the firmware route")
    allowedAsg.add(version(embedded.versionCode))
    await verifyFrozenFile(embedded.artifact)
    await verifyFrozenFile(embedded.evidence)
  }
  return {route, allowedFirmware, allowedAsg: [...allowedAsg]}
}

/** January Device Info exposes a suffix, full MAC and ASG build, not the full
 * serial. The separate hardware reader must still pin serial, CID and MAC. */
export function legacyAppPairChecks(bluetooth: string, asgVersion: number): Check[] {
  if (!/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(bluetooth)) throw new Error("A complete Bluetooth MAC is required")
  version(asgVersion)
  return [
    {selector: {description: `MAC address, ${bluetooth.toUpperCase()}`}},
    {selector: {description: `Build number, ${asgVersion}`}},
  ]
}
