import {createHash, randomUUID} from "node:crypto"
import {appendFile, mkdir, readFile, readdir, writeFile, open, statfs, unlink} from "node:fs/promises"
import {homedir} from "node:os"
import {join, relative, resolve} from "node:path"
import {bin, command, root, type Doctor, type Snapshot} from "./driver"
import {KEEP_AWAKE_SECONDS, keepAwake} from "./keep-awake"
import {bundledMiniappArtifacts} from "./miniapp-artifacts"
import {Video} from "./video"

export interface StepResult {
  id: string
  instruction: string
  expected: string
  status: "passed" | "failed" | "not-applicable" | "not-run"
  durationMs: number
  screenshot?: string
  accessibility?: string
  error?: string
  videoStart?: number
  videoEnd?: number
  screenshotSettled?: boolean
  screenshotVideoTime?: number
  screenshotObservedVideoTime?: number
  screenshotObservationAgeSeconds?: number
  focusBefore?: string
  focusAfter?: string
}

export function redact<T>(input: T, secrets: string[]): T {
  return JSON.parse(
    JSON.stringify(input, (_key, value) =>
      typeof value === "string"
        ? secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
        : value,
    ),
  )
}
const html = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

async function treeHash(directory: string): Promise<string> {
  const hash = createHash("sha256")
  async function visit(path: string) {
    for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue
      const file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) hash.update(relative(directory, file)).update(await readFile(file))
    }
  }
  await visit(directory)
  return hash.digest("hex")
}

export async function acquireLock() {
  const folder = join(homedir(), ".cache/mentra-e2e")
  await mkdir(folder, {recursive: true})
  const path = join(folder, "com.mentra.mentra.lock")
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600)
      await file.writeFile(JSON.stringify({pid: process.pid, token}))
      await file.close()
      return async () => {
        const current = JSON.parse(await readFile(path, "utf8"))
        if (current.token === token) await unlink(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const owner = JSON.parse(await readFile(path, "utf8"))
      try {
        process.kill(owner.pid, 0)
        throw new Error(`Another harness run owns the app (PID ${owner.pid})`)
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe
        await unlink(path)
      }
    }
  }
  throw new Error("Could not acquire app interaction lock")
}

export class Report {
  directory = ""
  results: StepResult[] = []
  started = new Date().toISOString()
  metadata: Record<string, unknown> = {}
  video?: Video
  private awake?: ReturnType<typeof keepAwake>
  constructor(
    readonly suite: string,
    readonly secrets: string[],
    private readonly readFinalApp = () => command<Doctor>({op: "doctor"}),
  ) {}

  async start(doctor: Doctor, fixture: string, buildManifestPath?: string) {
    this.directory = resolve(
      root,
      ".test-results/mentra-e2e",
      `${this.started.replace(/[:.]/g, "-")}-${this.suite}-${randomUUID().slice(0, 6)}`,
    )
    await mkdir(join(this.directory, "screenshots"), {recursive: true, mode: 0o700})
    await mkdir(join(this.directory, "accessibility"), {recursive: true, mode: 0o700})
    const git = Bun.spawn(["git", "rev-parse", "HEAD"], {cwd: root, stdout: "pipe"})
    const sourceReference = (await new Response(git.stdout).text()).trim()
    await git.exited
    this.metadata = {
      suite: this.suite,
      fixture,
      started: this.started,
      status: "running",
      executionMode: this.suite === "discovery" ? "interactive-discovery" : "deterministic-replay",
      modelCalls: this.suite === "discovery" ? null : 0,
      evidenceVersion: 2,
      sourceReference,
      app: doctor,
      appExecutableHash: doctor.executablePath
        ? createHash("sha256")
            .update(await readFile(doctor.executablePath))
            .digest("hex")
        : null,
      appJavascriptHash: doctor.javascriptPath
        ? createHash("sha256")
            .update(await readFile(doctor.javascriptPath))
            .digest("hex")
        : null,
      installedAppCommit: null,
      bundledMiniappArtifacts: await bundledMiniappArtifacts(doctor.bundlePath),
      harnessHash: await treeHash(resolve(root, "tools/mentra-e2e")),
      driverHash: createHash("sha256")
        .update(await readFile(bin))
        .digest("hex"),
      runtime: {
        bun: Bun.version,
        os: process.platform,
        architecture: process.arch,
        macOS: Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString().trim(),
        swift: Bun.spawnSync(["swiftc", "--version"]).stdout.toString().trim(),
      },
    }
    await this.flush()
    console.log(`Artifacts: ${this.directory}`)
    if (buildManifestPath) {
      const manifest = JSON.parse(await readFile(buildManifestPath, "utf8"))
      if (
        manifest.configuration !== "Release" ||
        manifest.bundleId !== doctor.bundleId ||
        manifest.executableSha256 !== this.metadata.appExecutableHash ||
        !manifest.javascriptSha256 ||
        manifest.javascriptSha256 !== this.metadata.appJavascriptHash
      )
        throw new Error("Build manifest does not match the running Release app's identity and binary/JavaScript hashes")
      this.metadata.verifiedLocalBuild = manifest
      this.metadata.installedAppCommit = manifest.sourceStatus === "" ? manifest.sourceCommit : null
      await this.flush()
    }
  }

  async startVideo() {
    if ((await command<Doctor>({op: "doctor"})).frontmostBundleId === "com.apple.loginwindow")
      throw new Error("The macOS login/lock screen is foreground; unlock this user session before replay")
    const disk = await statfs(this.directory)
    const availableBytes = disk.bavail * disk.bsize
    this.metadata.diskAvailableBytes = availableBytes
    await this.flush()
    if (availableBytes < 5 * 1024 ** 3)
      throw new Error(
        "Recording requires at least 5 GiB free on the artifact volume; macOS can stop capture during disk cache purges",
      )
    this.awake = keepAwake()
    this.metadata.keepAwake = {pid: this.awake.pid, timeoutSeconds: KEEP_AWAKE_SECONDS, released: false}
    this.video = new Video(join(this.directory, "routine.mp4"))
    const ready = await this.video.ready()
    this.metadata.video = {path: "routine.mp4", ...ready}
    await this.flush()
  }

  async record(result: StepResult, state?: Snapshot) {
    const stem = `${String(this.results.length + 1).padStart(3, "0")}-${result.id}-${result.status}`
    try {
      if (state) {
        result.accessibility = `accessibility/${stem}.json`
        await writeFile(
          join(this.directory, result.accessibility),
          JSON.stringify(redact(state, this.secrets), null, 2),
        )
      }
    } catch (error) {
      result.status = "failed"
      result.error = [result.error, `Accessibility evidence failed: ${String(error)}`].filter(Boolean).join("; ")
      delete result.accessibility
    }
    if (result.status !== "not-applicable" && result.status !== "not-run") {
      try {
        result.screenshot = `screenshots/${stem}.png`
        const path = join(this.directory, result.screenshot)
        const image = this.video
          ? await this.video.screenshot(path)
          : await command<{width: number; height: number; bytes: number}>({op: "screenshot", path})
        if ("settled" in image) result.screenshotSettled = Boolean(image.settled)
        if ("frameTime" in image) result.screenshotVideoTime = Number(image.frameTime)
        if ("observationTime" in image) result.screenshotObservedVideoTime = Number(image.observationTime)
        if ("observationAgeSeconds" in image)
          result.screenshotObservationAgeSeconds = Number(image.observationAgeSeconds)
        const bytes = await readFile(join(this.directory, result.screenshot))
        if (
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          image.width < 1 ||
          image.height < 1 ||
          image.bytes < 1
        )
          throw new Error("Invalid PNG capture")
      } catch (error) {
        result.status = "failed"
        result.error = [result.error, `Screenshot failed: ${String(error)}`].filter(Boolean).join("; ")
        delete result.screenshot
      }
    }
    const safe = redact(result, this.secrets)
    this.results.push(safe)
    await appendFile(join(this.directory, "events.jsonl"), `${JSON.stringify(safe)}\n`)
    await this.flush()
    console.log(`${safe.status.toUpperCase()} ${safe.id}: ${safe.instruction}${safe.error ? ` — ${safe.error}` : ""}`)
    return safe
  }

  async flush() {
    await writeFile(
      join(this.directory, "run.json"),
      JSON.stringify(redact({...this.metadata, results: this.results}, this.secrets), null, 2),
    )
    await writeFile(
      join(this.directory, "checklist.md"),
      "# Executed routine\n\n" +
        this.results
          .map(
            (step, index) =>
              `${index + 1}. **${step.id} (${step.status})** ${step.instruction} Expected: ${step.expected}`,
          )
          .join("\n"),
    )
    await writeFile(
      join(this.directory, "chapters.json"),
      JSON.stringify(
        this.results
          .filter((step) => step.videoStart !== undefined)
          .map((step) => ({
            id: step.id,
            description: step.instruction,
            expected: step.expected,
            start: step.videoStart,
            end: step.videoEnd,
            status: step.status,
          })),
        null,
        2,
      ),
    )
    await writeFile(
      join(this.directory, "index.html"),
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mentra E2E run</title><style>body{font:16px system-ui;max-width:1200px;margin:24px auto;padding:0 20px}main{display:grid;grid-template-columns:minmax(300px,480px) 1fr;gap:24px}.player{position:sticky;top:20px;align-self:start}video{width:100%;max-height:85vh;background:#eee}article{border-top:1px solid #ddd;padding:16px 0}img{max-width:300px;width:100%;height:auto}pre{white-space:pre-wrap}.failed{color:#a00}button{font:inherit;text-align:left;cursor:pointer;padding:8px 12px}input{font:inherit;width:90%;padding:10px}@media(max-width:700px){main{display:block}.player{position:relative}}</style><h1>Mentra E2E: ${html(
        this.suite,
      )}</h1><p>${html(String(this.metadata.status))} — ${html(
        this.started,
      )}</p><main><div class="player"><video id="video" controls preload="metadata" src="routine.mp4"></video><p>Select an English step to jump to its start.</p><p><a href="routine.mp4">Download video</a> · <a href="chapters.json">Step timestamps</a></p></div><div><input id="search" placeholder="Find a step by its description" aria-label="Find a step">${this.results
        .map(
          (step) =>
            `<article id="${html(step.id)}"><h2 class="${step.status}">${html(step.id)} · ${html(step.status)}</h2>${
              step.videoStart !== undefined
                ? `<button data-time="${step.videoStart}">${step.videoStart.toFixed(1)}s — ${html(
                    step.instruction,
                  )}</button>`
                : `<p>${html(step.instruction)}</p>`
            }<p>Expected: ${html(step.expected)}</p>${step.error ? `<pre>${html(step.error)}</pre>` : ""}${
              step.screenshot
                ? `<details><summary>Screenshot</summary><a href="${step.screenshot}"><img src="${step.screenshot}" loading="lazy"></a></details>`
                : ""
            }</article>`,
        )
        .join(
          "",
        )}</div></main><script>const video=document.querySelector('video');document.querySelectorAll('[data-time]').forEach(button=>button.onclick=()=>{video.currentTime=Number(button.dataset.time);video.play().catch(()=>{})});document.querySelector('#search').oninput=event=>document.querySelectorAll('article').forEach(article=>article.hidden=!article.textContent.toLowerCase().includes(event.target.value.toLowerCase()));</script>`,
    )
  }

  async finish(status: string, cleanup: string) {
    if (this.results.some((step) => step.status === "failed")) status = "failed"
    else if (status === "passed" && (!this.results.length || this.results.some((step) => step.status === "not-run")))
      status = "incomplete"
    if (status === "passed" && !this.video) {
      status = "incomplete"
      cleanup += "; no continuous recording was started"
    }
    if (this.video) {
      try {
        this.metadata.video = {...(this.metadata.video as object), ...(await this.video.stop())}
      } catch (error) {
        if (status !== "failed") status = "incomplete"
        cleanup += `; video finalization failed: ${String(error)}`
      }
      this.video = undefined
    }
    if (this.awake) {
      await this.awake.stop()
      this.metadata.keepAwake = {...(this.metadata.keepAwake as object), released: true}
      this.awake = undefined
    }
    if (status === "passed") {
      try {
        const finalApp = await this.readFinalApp()
        this.metadata.finalApp = finalApp
        const executableHash = createHash("sha256")
          .update(await readFile(finalApp.executablePath))
          .digest("hex")
        const javascriptHash = finalApp.javascriptPath
          ? createHash("sha256")
              .update(await readFile(finalApp.javascriptPath))
              .digest("hex")
          : null
        if (executableHash !== this.metadata.appExecutableHash || javascriptHash !== this.metadata.appJavascriptHash)
          throw new Error("The running binary changed during the routine")
      } catch (error) {
        status = "incomplete"
        cleanup += `; final app identity check failed: ${String(error)}`
      }
    }
    this.metadata = {...this.metadata, ended: new Date().toISOString(), status, cleanup}
    await this.flush()
    await writeFile(
      join(this.directory, "summary.md"),
      `# ${this.suite}: ${status}\n\nCleanup: ${cleanup}\n\n` +
        this.results.map((step) => `- ${step.id}: ${step.status}${step.error ? ` — ${step.error}` : ""}`).join("\n") +
        "\n",
    )
    return status
  }
}
