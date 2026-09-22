import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {join, resolve} from "node:path"
import type {StepResult} from "./runner/report"

// Independent artifact checks. ffprobe is a verification dependency only;
// capture and normal replay use Apple's native frameworks.
const folder = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("Usage: bun tools/mentra-e2e/verify-run.ts <run-folder>")
const run = JSON.parse(await readFile(join(folder, "run.json"), "utf8"))
const steps = run.results as StepResult[]
assert.notEqual(run.status, "running", "Run was not finalized")
assert.equal(new Set(steps.map((step) => step.id)).size, steps.length, "Duplicate step IDs")
const probe = Bun.spawnSync([
  "ffprobe",
  "-v",
  "error",
  "-select_streams",
  "v:0",
  "-show_entries",
  "stream=codec_name,width,height,nb_frames,duration",
  "-of",
  "json",
  join(folder, "routine.mp4"),
])
assert.equal(probe.exitCode, 0, "ffprobe could not read the completed video")
const video = JSON.parse(probe.stdout.toString()).streams[0]
assert.equal(video.codec_name, "h264")
const duration = Number(video.duration)
assert.ok(duration > 0 && Number(video.nb_frames) > 0, "Empty video")
assert.ok(Math.abs(duration - run.video.duration) < 0.1, "Reported video duration differs from ffprobe")
const chapters = JSON.parse(await readFile(join(folder, "chapters.json"), "utf8"))
const viewer = await readFile(join(folder, "index.html"), "utf8")
let executed = 0
let previousStart = -1
for (const step of steps) {
  if (step.status === "not-applicable" || step.status === "not-run") continue
  executed++
  assert.ok(step.screenshot && step.accessibility, `${step.id}: missing screenshot or AX evidence`)
  const png = await readFile(join(folder, step.screenshot))
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${step.id}: invalid PNG`)
  assert.equal(png.readUInt32BE(16), video.width, `${step.id}: screenshot width mismatch`)
  assert.equal(png.readUInt32BE(20), video.height, `${step.id}: screenshot height mismatch`)
  const state = JSON.parse(await readFile(join(folder, step.accessibility), "utf8"))
  for (const element of state.elements) {
    if (element.subrole === "AXSecureTextField") assert.equal(element.value, "[REDACTED]")
  }
  assert.ok(step.videoStart !== undefined && step.videoEnd !== undefined, `${step.id}: missing chapter times`)
  assert.ok(step.videoStart >= previousStart && step.videoEnd >= step.videoStart, `${step.id}: reversed times`)
  assert.ok(step.videoEnd <= duration + 0.1, `${step.id}: chapter exceeds video`)
  assert.ok(
    step.screenshotVideoTime !== undefined && step.screenshotVideoTime <= duration + 0.1,
    `${step.id}: screenshot exceeds video`,
  )
  if (run.evidenceVersion >= 2) {
    assert.ok(
      step.screenshotObservationAgeSeconds !== undefined &&
        step.screenshotObservationAgeSeconds >= 0 &&
        step.screenshotObservationAgeSeconds <= 1,
      `${step.id}: stale or missing screen observation`,
    )
    assert.ok(
      step.screenshotObservedVideoTime !== undefined &&
        step.screenshotObservedVideoTime >= step.videoEnd - 1 &&
        step.screenshotObservedVideoTime <= duration + 0.1,
      `${step.id}: screen observation is outside the step's evidence interval`,
    )
  }
  previousStart = step.videoStart
  const chapter = chapters.find((entry: {id: string}) => entry.id === step.id)
  assert.equal(chapter?.start, step.videoStart, `${step.id}: mismatched chapter index`)
  assert.ok(viewer.includes(`data-time="${step.videoStart}"`), `${step.id}: missing viewer link`)
}
assert.equal(chapters.length, executed)
if (run.status === "passed") assert.ok(steps.every((step) => ["passed", "not-applicable"].includes(step.status)))
console.log(
  JSON.stringify(
    {
      status: run.status,
      executed,
      duration,
      width: video.width,
      height: video.height,
      modelCalls: run.modelCalls,
      recovery: run.recovery,
      artifactChecks: "passed",
      frameLiveness: run.evidenceVersion >= 2 ? "verified" : "not-recorded-by-legacy-run",
      browserInteraction: "not-verified",
    },
    null,
    2,
  ),
)
