import {createHash} from "node:crypto"
import {createReadStream} from "node:fs"
import {mkdir, readFile, realpath, stat} from "node:fs/promises"
import {join} from "node:path"
import {verifyBuildManifest} from "./build-manifest"
import {bin, command, match, type Command, type Doctor, type Snapshot} from "./driver"
import {otaPage} from "./ota-state"
import {otaAudioNotice, otaAudioNoticeCommand, otaAudioNoticeStep} from "./ota-audio-notice"
import {checkPairedHome} from "./return-observer"
import type {AppContext, AppObserver, AppProof} from "./return-collector"

type Ui = <T>(input: Command) => Promise<T>
type Settings = {buildManifest: string; buildManifestSha256: string}
export type AppScreenshot = {width: number; height: number; bytes: number}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
async function fileHash(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

/** Run under the collector's existing lease. An active Report must supply its
 * owned Video.screenshot here, sequentially with its other recorder operations;
 * standalone collection uses the native screenshot command. Other injected reads
 * support offline tests. A failed capture never falls back to another recorder. */
export function appObserver(
  settings: Settings,
  dependencies: {
    ui?: Ui
    processStart?: (pid: number, context: AppContext) => Promise<string>
    driverHash?: () => Promise<string>
    captureScreenshot?: (path: string) => Promise<AppScreenshot>
  } = {},
): AppObserver {
  const native = dependencies.ui ?? command
  const processStart =
    dependencies.processStart ?? ((pid, {recorder}) => recorder.run(["/bin/ps", "-p", String(pid), "-o", "lstart="]))
  const driverHash = dependencies.driverHash ?? (() => fileHash(bin))
  let sequence = 0
  let manifest: unknown
  let baseline: Awaited<ReturnType<typeof provenance>> | undefined
  let info: Snapshot | undefined
  let home: Snapshot | undefined
  let captureTimes: string[] = []

  async function ui<T>(input: Command, {recorder}: AppContext) {
    const id = `ui-${String(++sequence).padStart(4, "0")}`
    const startedAt = new Date().toISOString()
    const capture = input.op === "screenshot" ? dependencies.captureScreenshot : undefined
    const invocation = capture ? {captureSource: "caller-screenshot-hook", request: input} : {argv: [bin], stdin: input}
    await recorder.append({event: "app-command-intent", id, startedAt, ...invocation})
    try {
      const value = capture ? ((await capture(input.path!)) as T) : await native<T>(input)
      const finishedAt = new Date().toISOString()
      await recorder.json(`${id}.json`, {startedAt, finishedAt, ...invocation, value, exitCode: 0})
      await recorder.append({event: "app-command-result", id, finishedAt, exitCode: 0})
      return {value, startedAt, finishedAt}
    } catch (error) {
      await recorder.json(`${id}.json`, {
        startedAt,
        finishedAt: new Date().toISOString(),
        ...invocation,
        error: String(error),
      })
      await recorder.append({event: "app-command-error", id, error: String(error)})
      throw error
    }
  }

  async function provenance(context: AppContext) {
    const read = await ui<Doctor>({op: "doctor"}, context)
    const doctor = read.value
    if (
      !doctor.accessibility ||
      !doctor.screenCapture ||
      doctor.frontmostBundleId === "com.apple.loginwindow" ||
      !Number.isSafeInteger(doctor.pid) ||
      doctor.pid <= 0
    )
      throw new Error("Selected app is unavailable, locked or missing existing capture/accessibility permission")
    const [executable, javascript, bundle, started] = await Promise.all([
      realpath(doctor.executablePath),
      realpath(doctor.javascriptPath),
      realpath(doctor.bundlePath),
      processStart(doctor.pid, context),
    ])
    if (!executable.startsWith(bundle + "/") || !javascript.startsWith(bundle + "/") || !started.trim())
      throw new Error("Running app paths or process start cannot be established")
    const [executableSha256, javascriptSha256] = await Promise.all([fileHash(executable), fileHash(javascript)])
    const appConfig = await readFile(join(bundle, "EXConstants.bundle/app.config"))
    if (
      appConfig.length > 1024 * 1024 ||
      JSON.parse(appConfig.toString()).extra?.mentraPrBuild?.otaManifestUrl !== context.profile.manifest.url
    )
      throw new Error("Actual packaged app configuration has a different OTA manifest pin")
    const verified = verifyBuildManifest(manifest, {...doctor, executableSha256, javascriptSha256})
    return {
      doctor,
      executable,
      javascript,
      bundle,
      processStart: started.trim(),
      executableSha256,
      javascriptSha256,
      appConfigSha256: hash(appConfig),
      verified,
      startedAt: read.startedAt,
      finishedAt: new Date().toISOString(),
    }
  }

  function sameApp(value: Awaited<ReturnType<typeof provenance>>) {
    if (
      !baseline ||
      value.doctor.pid !== baseline.doctor.pid ||
      value.processStart !== baseline.processStart ||
      value.executable !== baseline.executable ||
      value.javascript !== baseline.javascript ||
      value.bundle !== baseline.bundle
    )
      throw new Error("Selected app process or paths changed during return observation")
  }

  async function state(context: AppContext) {
    const read = await ui<Snapshot>({op: "snapshot"}, context)
    if (!baseline || read.value.pid !== baseline.doctor.pid || read.value.frontmostBundleId === "com.apple.loginwindow")
      throw new Error("App snapshot is from another process or the Mac locked")
    return read
  }

  async function press(selector: NonNullable<Command["selector"]>, context: AppContext) {
    const current = await state(context)
    const found = current.value.elements.filter(
      (element) => match(element, {...selector, enabled: true}, current.value) && element.actions.includes("AXPress"),
    )
    if (found.length !== 1) throw new Error("Expected one enabled semantic navigation control")
    await ui({op: "press", selector: {...selector, enabled: true}}, context) // One press only; never resend.
  }

  async function screen(
    name: string,
    instruction: string,
    predicate: (value: Snapshot) => boolean,
    context: AppContext,
  ) {
    const deadline = Date.now() + 5000
    let observed = await state(context)
    while (!predicate(observed.value)) {
      if (Date.now() >= deadline) throw new Error(`App did not reach ${name}`)
      await Bun.sleep(100)
      observed = await state(context)
    }
    const path = join(context.recorder.output, "app", `${name}.png`)
    if (await Bun.file(path).exists()) throw new Error("Screenshot evidence already exists")
    const image = await ui<{width: number; height: number; bytes: number}>({op: "screenshot", path}, context)
    const bytes = await readFile(path)
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      image.value.bytes !== bytes.length ||
      image.value.width !== bytes.readUInt32BE(16) ||
      image.value.height !== bytes.readUInt32BE(20)
    )
      throw new Error("Native screenshot bytes/dimensions are invalid")
    const after = await state(context)
    if (!predicate(after.value)) throw new Error(`App left ${name} during screenshot capture`)
    captureTimes.push(observed.startedAt, image.startedAt, image.finishedAt, after.finishedAt)
    await context.recorder.json(`app/${name}.json`, {
      instruction,
      startedAt: observed.startedAt,
      finishedAt: after.finishedAt,
      before: observed.value,
      after: after.value,
      screenshot: {path, sha256: hash(bytes), ...image.value},
    })
    return after.value
  }

  const contains = (value: Snapshot, label: string) =>
    value.elements.some((row) => row.visible && row.description.includes(label))
  return {
    async prepare(context) {
      if (
        !/^[a-f0-9]{64}$/.test(settings.buildManifestSha256) ||
        (await stat(settings.buildManifest)).size > 1024 * 1024
      )
        throw new Error("Exact bounded build manifest is required")
      const bytes = await readFile(settings.buildManifest)
      if (hash(bytes) !== settings.buildManifestSha256) throw new Error("Build manifest SHA mismatch")
      manifest = JSON.parse(bytes.toString())
      if (
        !(manifest && typeof manifest === "object") ||
        (manifest as Record<string, unknown>).otaManifestUrl !== context.profile.manifest.url
      )
        throw new Error("App build manifest must select the same frozen OTA manifest")
      await mkdir(join(context.recorder.output, "app"), {mode: 0o700})
      await context.recorder.file("app/build.json", bytes)
      const driverSha256 = await driverHash()
      baseline = await provenance(context)
      await context.recorder.json("app/provenance-before.json", {
        ...baseline,
        driverSha256,
        buildManifestSha256: settings.buildManifestSha256,
        observerSha256: hash(await readFile(import.meta.path)),
      })
      const initial = (await state(context)).value
      if (otaPage(initial).kind !== "home" || otaAudioNotice(initial) === "blocked")
        throw new Error("Start return observation at paired home with no unrecognized audio notice")
    },
    async capture(context) {
      if (!baseline) throw new Error("App provenance was not prepared under the lease")
      captureTimes = []
      const current = await state(context)
      const notice = otaAudioNotice(current.value)
      if (notice === "blocked") throw new Error("The glasses audio notice is incomplete or ambiguous")
      if (notice === "dismissible") {
        const step = otaAudioNoticeStep("return-audio-notice")
        await ui(otaAudioNoticeCommand((await state(context)).value), context) // One exact notice; no retry.
        await screen(
          "audio-notice-dismissed",
          step.instruction,
          (s) => otaAudioNotice(s) === "absent" && otaPage(s).kind === "home",
          context,
        )
      }
      await press({identifier: "home.miniapp.com.mentra.settings"}, context)
      await screen(
        "settings",
        "Open Settings to identify the paired glasses.",
        (s) => contains(s, "Device info"),
        context,
      )
      await press({role: "AXGenericElement", contains: "Device info"}, context)
      info = await screen(
        "device-info",
        "Read the paired glasses' full MAC and current ASG build.",
        (s) => contains(s, "MAC address, ") && contains(s, "Build number, "),
        context,
      )
      await press({identifier: "miniapp.close"}, context)
      home = await screen(
        "paired-home",
        "Return to the unobstructed, connected Mentra Live home.",
        (s) => otaPage(s).kind === "home" && otaAudioNotice(s) === "absent",
        context,
      )
      const connected = checkPairedHome(home, info, context.fixture.bluetooth, context.profile.asg.versionCode)
      return {connected, capturedAt: [...captureTimes], evidence: join(context.recorder.output, "app/proof.json")}
    },
    async finish(context, proof) {
      const final = await provenance(context)
      sameApp(final)
      if (!home || !info) throw new Error("Required app captures are missing")
      const latest = await state(context)
      const connected =
        proof.connected &&
        checkPairedHome(latest.value, info, context.fixture.bluetooth, context.profile.asg.versionCode)
      const result = {
        ...proof,
        connected,
        capturedAt: [...proof.capturedAt, final.startedAt, final.finishedAt, latest.finishedAt],
      }
      await context.recorder.json("app/provenance-after.json", final)
      await context.recorder.json("app/proof.json", {
        ...result,
        finalHome: latest.value,
        scope: "Current selected app bytes/process, exact paired MAC/ASG and connected home; no fixture state mutation",
      })
      return result
    },
  }
}
