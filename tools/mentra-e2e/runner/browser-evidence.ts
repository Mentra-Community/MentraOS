import {createHash} from "node:crypto"
import {readFile, writeFile} from "node:fs/promises"
import {join} from "node:path"

export type BrowserChapter = {id: string; instruction: string; elapsedMs: number; phase: string}
export type VideoCalibration = {beforeMs: number; afterMs: number}

async function run(args: string[]) {
  const child = Bun.spawn(args, {stdout: "pipe", stderr: "pipe"})
  const timeout = setTimeout(() => child.kill(), 180_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code) throw new Error(`${args[0]} failed: ${stderr.slice(-1500)}`)
    return Buffer.from(stdout)
  } finally {
    clearTimeout(timeout)
  }
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!))

export function browserTimeline(
  calibration: VideoCalibration,
  markerSeconds: number,
  events: BrowserChapter[],
  duration: number,
) {
  if (
    ![calibration.beforeMs, calibration.afterMs, markerSeconds, duration].every(Number.isFinite) ||
    calibration.beforeMs < 0 ||
    calibration.afterMs < calibration.beforeMs ||
    markerSeconds <= 0 ||
    duration <= 0
  )
    throw new Error("Invalid browser recording calibration")
  const offsetSeconds = (calibration.beforeMs + calibration.afterMs) / 2000 - markerSeconds
  const uncertaintyMs = (calibration.afterMs - calibration.beforeMs) / 2 + 40
  if (uncertaintyMs > 200) throw new Error("Browser video calibration was delayed; chapter timing is unqualified")
  const chapters = events.map((event, index) => {
    const videoSeconds = event.elapsedMs / 1000 - offsetSeconds
    if (
      !Number.isFinite(videoSeconds) ||
      videoSeconds < 0 ||
      videoSeconds > duration ||
      (index > 0 && event.elapsedMs < events[index - 1].elapsedMs)
    )
      throw new Error("Browser chapter falls outside the recorded timeline")
    return {...event, videoSeconds}
  })
  return {
    method: "Recorded green marker before Teams navigation",
    markerSeconds,
    offsetSeconds,
    uncertaintyMs,
    duration,
    chapters,
  }
}

/** Match an explicit green calibration frame recorded before navigating to Teams. */
export async function finishBrowserEvidence(
  directory: string,
  videoPath: string,
  calibration: VideoCalibration,
  events: BrowserChapter[],
) {
  const pixels = await run([
    "ffmpeg",
    "-v",
    "error",
    "-i",
    videoPath,
    "-t",
    "5",
    "-vf",
    "fps=25,scale=1:1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ])
  let markerFrame = -1
  for (let i = 0; i < pixels.length / 3; i++) {
    if (pixels[i * 3] < 20 && pixels[i * 3 + 1] > 230 && pixels[i * 3 + 2] < 20) {
      markerFrame = i
      break
    }
  }
  if (markerFrame <= 0) throw new Error("Browser video calibration marker is missing or recording began too late")
  const markerSeconds = markerFrame / 25
  await run([
    "ffmpeg",
    "-v",
    "error",
    "-i",
    videoPath,
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(directory, "routine.mp4"),
  ])
  const probe = JSON.parse(
    (
      await run([
        "ffprobe",
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        join(directory, "routine.mp4"),
      ])
    ).toString(),
  )
  const timeline = browserTimeline(calibration, markerSeconds, events, Number(probe.format.duration))
  if (
    !probe.streams.some(
      (stream: {codec_type: string; width: number; height: number}) =>
        stream.codec_type === "video" && stream.width === 1280 && stream.height === 800,
    )
  )
    throw new Error("Browser recording dimensions differ from the declared viewport")
  const {chapters, uncertaintyMs} = timeline
  const metadata = {
    ...timeline,
    mp4Sha256: createHash("sha256")
      .update(await readFile(join(directory, "routine.mp4")))
      .digest("hex"),
  }
  await writeFile(join(directory, "chapters.json"), JSON.stringify(metadata, null, 2) + "\n")
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Mentra Call browser evidence</title><style>body{margin:2rem;background:#101b24;color:#eff6ff;font:16px system-ui}video{width:min(100%,1000px);display:block}button{display:block;margin:.5rem 0;padding:.7rem;text-align:left;background:#213547;color:inherit;border:1px solid #58718a;border-radius:6px;cursor:pointer}small{color:#b8c9da}</style><h1>Mentra Call browser routine</h1><p>Continuous browser recording. Chapters describe the device selections and media checks performed in this run. Audible audio requires a listener check. Chapter calibration uncertainty: ±${Math.ceil(
      uncertaintyMs,
    )} ms.</p><video controls src="routine.mp4"></video><nav>${chapters
      .map(
        (c) =>
          `<button data-seek="${c.videoSeconds.toFixed(3)}">${escape(c.id)} · ${escape(
            c.instruction,
          )}<br><small>${escape(c.phase)} · ${c.videoSeconds.toFixed(2)} s</small></button>`,
      )
      .join(
        "",
      )}</nav><script>const video=document.querySelector('video');document.querySelectorAll('[data-seek]').forEach(button=>button.onclick=()=>{video.currentTime=Number(button.dataset.seek);video.play()})</script></html>`,
  )
  return metadata
}
