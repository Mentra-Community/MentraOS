import {createHash} from "node:crypto"
import {constants} from "node:fs"
import {lstat, mkdir, open, writeFile} from "node:fs/promises"
import {dirname, isAbsolute, join, parse, resolve, sep} from "node:path"
import {MAX_ASSET_BYTES, MAX_METADATA_BYTES, requireThat, type TestRunAsset} from "./test-run-record"

export interface MediaProbe {
  duration: number
  width: number
  height: number
}
export type ChapterPhase = "setup" | "test" | "verify" | "teardown"
type Row = Record<string, any>
export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
function object(value: unknown, name: string): Row {
  requireThat(value && typeof value === "object" && !Array.isArray(value), `Invalid ${name}`)
  return value as Row
}
function text(value: unknown, name: string, max = 2000): string {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= max, `Invalid ${name}`)
  return value
}
export async function noLinks(path: string) {
  const full = resolve(path)
  let current = parse(full).root
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    requireThat(!(await lstat(current)).isSymbolicLink(), "Export input/output paths must not traverse symlinks")
  }
  return full
}
export async function stableBytes(path: string, limit: number) {
  await noLinks(path)
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await fd.stat()
    requireThat(
      before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= limit,
      "Export input must be a regular private file within its size limit",
    )
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const {bytesRead} = await fd.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const bytes = buffer.subarray(0, length)
    const after = await fd.stat()
    requireThat(
      bytes.length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "Source changed during export",
    )
    return bytes
  } finally {
    await fd.close()
  }
}

export function child(root: string, path: unknown) {
  const name = text(path, "relative source asset", 4096)
  requireThat(
    !isAbsolute(name) &&
      !name.includes("\\") &&
      !/[\x00-\x1f\x7f]/.test(name) &&
      name.split("/").every((part) => part && part !== "." && part !== ".."),
    "Asset path escapes the source run",
  )
  return join(root, name)
}
export async function probe(path: string): Promise<MediaProbe> {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,nb_frames,duration",
      "-of",
      "json",
      path,
    ],
    {stdout: "pipe", stderr: "pipe"},
  )
  const timer = setTimeout(() => process.kill(), 15000)
  try {
    const [output, code] = await Promise.all([new Response(process.stdout).text(), process.exited])
    requireThat(code === 0, "ffprobe could not verify the finalized recording")
    const stream = JSON.parse(output).streams?.[0]
    requireThat(
      stream?.codec_name === "h264" &&
        Number(stream.nb_frames) > 0 &&
        Number(stream.duration) > 0 &&
        Number.isSafeInteger(stream.width) &&
        stream.width > 0 &&
        Number.isSafeInteger(stream.height) &&
        stream.height > 0,
      "Recording is not a nonempty H264 video",
    )
    return {duration: Number(stream.duration), width: stream.width, height: stream.height}
  } finally {
    clearTimeout(timer)
  }
}
async function decodeScreenshot(path: string) {
  const process = Bun.spawn(["ffmpeg", "-v", "error", "-xerror", "-i", path, "-frames:v", "1", "-f", "null", "-"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  const timer = setTimeout(() => process.kill(), 15000)
  try {
    requireThat((await process.exited) === 0, "Screenshot cannot be decoded completely")
  } finally {
    clearTimeout(timer)
  }
}

/** Copies only validated media into a fresh private output directory. No outcome inference. */
export async function copyRecordedEvidence(
  source: string,
  outputDirectory: string,
  run: Row,
  phases: Record<string, ChapterPhase>,
  inspectVideo = probe,
) {
  const videoPath = join(source, "routine.mp4")
  requireThat(run.video?.event === "finished", "Recording was not finalized")
  const sourceChaptersBytes = await stableBytes(join(source, "chapters.json"), MAX_METADATA_BYTES)
  const sourceChapters = JSON.parse(sourceChaptersBytes.toString("utf8"))
  requireThat(Array.isArray(sourceChapters), "Missing source chapters")
  const assets: TestRunAsset[] = [],
    localAssets: {assetId: string; path: string}[] = [],
    originals: {path: string; digest: string}[] = []
  const output = resolve(outputDirectory)
  await noLinks(dirname(output))
  await mkdir(output, {mode: 0o700})
  async function add(
    assetId: string,
    kind: TestRunAsset["kind"],
    contentType: TestRunAsset["contentType"],
    filename: string,
    bytes: Buffer,
  ) {
    requireThat(bytes.length > 0 && bytes.length <= MAX_ASSET_BYTES, "Evidence exceeds the admin asset size limit")
    const sha256 = hash(bytes)
    await writeFile(join(output, filename), bytes, {flag: "wx", mode: 0o600})
    assets.push({assetId, kind, contentType, filename, sizeBytes: bytes.length, sha256})
    localAssets.push({assetId, path: filename})
  }
  async function copy(
    assetId: string,
    kind: TestRunAsset["kind"],
    contentType: TestRunAsset["contentType"],
    filename: string,
    path: string,
  ) {
    const bytes = await stableBytes(path, MAX_ASSET_BYTES)
    originals.push({path, digest: hash(bytes)})
    await add(assetId, kind, contentType, filename, bytes)
    return bytes
  }
  const videoBytes = await copy("recording", "video", "video/mp4", "routine.mp4", videoPath)
  requireThat(videoBytes.subarray(4, 8).toString() === "ftyp", "Recording is not MP4")
  // Probe the same frozen bytes that are published, never a replaceable source pathname.
  const video = await inspectVideo(join(output, "routine.mp4"))
  requireThat(
    Number.isFinite(video.duration) && video.duration > 0 && Math.abs(video.duration - run.video.duration) < 0.1,
    "Finalized recording duration changed",
  )
  const chapters: Row[] = []
  const ids = new Set<string>()
  let previous = -1
  for (const [index, value] of run.results.entries()) {
    const step = object(value, "source step")
    requireThat(ID.test(step.id ?? "") && !ids.has(step.id), "Duplicate or malformed step ID")
    ids.add(step.id)
    requireThat(["passed", "failed", "not-run", "not-applicable"].includes(step.status), "Unknown source step verdict")
    const phase = phases[step.id] ?? "test"
    requireThat(["setup", "test", "verify", "teardown"].includes(phase), "Invalid chapter phase")
    const chapter: Row = {
      id: step.id,
      instruction: text(step.instruction, "step instruction"),
      expected: text(step.expected, "step expectation"),
      status: step.status === "not-applicable" ? "not-run" : step.status,
      phase,
    }
    if (!["not-run", "not-applicable"].includes(step.status)) {
      const original = sourceChapters.filter((entry: Row) => entry.id === step.id)
      requireThat(
        original.length === 1 &&
          original[0].start === step.videoStart &&
          original[0].end === step.videoEnd &&
          original[0].description === step.instruction &&
          original[0].expected === step.expected &&
          original[0].status === step.status,
        "Chapter does not match source result",
      )
      requireThat(
        Number.isFinite(step.videoStart) &&
          step.videoStart >= 0 &&
          step.videoStart >= previous &&
          Number.isFinite(step.videoEnd) &&
          step.videoEnd >= step.videoStart &&
          step.videoEnd <= video.duration + 0.1,
        "Chapter is outside the finalized video",
      )
      requireThat(
        Number.isFinite(step.screenshotVideoTime) &&
          step.screenshotVideoTime >= 0 &&
          step.screenshotVideoTime <= video.duration + 0.1 &&
          Number.isFinite(step.screenshotObservationAgeSeconds) &&
          step.screenshotObservationAgeSeconds >= 0 &&
          step.screenshotObservationAgeSeconds <= 1 &&
          Number.isFinite(step.screenshotObservedVideoTime) &&
          step.screenshotObservedVideoTime >= Math.max(0, step.videoEnd - 1) &&
          step.screenshotObservedVideoTime <= video.duration + 0.1,
        "Screenshot is stale or outside the recorded evidence interval",
      )
      previous = step.videoStart
      const screenshotId = `screenshot-${String(index + 1).padStart(3, "0")}`
      const png = await copy(
        screenshotId,
        "screenshot",
        "image/png",
        `${screenshotId}.png`,
        child(source, step.screenshot),
      )
      requireThat(
        png.length >= 24 &&
          png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
          png.readUInt32BE(16) === video.width &&
          png.readUInt32BE(20) === video.height,
        "Screenshot dimensions/format differ from recorded video",
      )
      await decodeScreenshot(join(output, `${screenshotId}.png`))
      Object.assign(chapter, {
        videoAssetId: "recording",
        videoStart: step.videoStart,
        videoEnd: step.videoEnd,
        screenshotAssetId: screenshotId,
      })
    }
    chapters.push(chapter)
  }
  requireThat(
    sourceChapters.length === chapters.filter((entry) => entry.videoAssetId).length,
    "Unexpected source chapters",
  )
  await add(
    "chapters",
    "metadata",
    "application/json",
    "chapters.json",
    Buffer.from(JSON.stringify(chapters, null, 2) + "\n"),
  )

  async function verifyUnchanged() {
    requireThat(
      hash(await stableBytes(join(source, "chapters.json"), MAX_METADATA_BYTES)) === hash(sourceChaptersBytes),
      "Source chapters changed while exporting",
    )
    for (const original of originals)
      requireThat(
        hash(await stableBytes(original.path, MAX_ASSET_BYTES)) === original.digest,
        "Source asset changed while exporting",
      )
    for (const asset of assets)
      requireThat(
        hash(await stableBytes(join(output, asset.filename), MAX_ASSET_BYTES)) === asset.sha256,
        "Frozen output asset changed while exporting",
      )
  }
  return {output, assets, localAssets, chapters, video, add, verifyUnchanged}
}
