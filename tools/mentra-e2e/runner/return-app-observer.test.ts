import {afterEach, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import type {Command, Doctor, Element, Snapshot} from "./driver"
import {assertFirmwareState, type FirmwareProfile} from "./firmware-profile"
import {OTA_AUDIO_NOTICE_BODY, OTA_AUDIO_NOTICE_TITLE} from "./ota-audio-notice"
import {appProofWithinBracket} from "./return-collector"
import {TestReturnRecorder as Recorder} from "./return-collector.test-support"
import {appObserver, type AppScreenshot} from "./return-app-observer"

const owned: string[] = []
afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, {recursive: true, force: true})))
})
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const element = (patch: Partial<Element>): Element => ({
  path: "0",
  role: "AXGenericElement",
  subrole: "",
  title: "",
  description: "",
  placeholder: "",
  identifier: "",
  value: "",
  enabled: true,
  focused: false,
  visible: true,
  actions: ["AXPress"],
  ...patch,
})
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJHkAAAAASUVORK5CYII=",
  "base64",
)

async function setup(captureScreenshot?: (path: string) => Promise<AppScreenshot>) {
  const root = await mkdtemp(join(tmpdir(), "mentra-combined-return-"))
  owned.push(root)
  const bundle = join(root, "Mentra.app")
  await mkdir(join(bundle, "EXConstants.bundle"), {recursive: true})
  await writeFile(join(bundle, "Mentra"), "test executable")
  await writeFile(join(bundle, "main.jsbundle"), "test javascript")
  const otaUrl = `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-4136-${"a".repeat(
    40,
  )}.json`
  await writeFile(
    join(bundle, "EXConstants.bundle/app.config"),
    JSON.stringify({extra: {mentraPrBuild: {otaManifestUrl: otaUrl}}}),
  )
  const manifest = {
    pr: 4136,
    headSha: "a".repeat(40),
    buildSha: "b".repeat(40),
    runId: 12,
    runAttempt: 1,
    bundleId: "com.mentra.mentra",
    app: "Mentra.app",
    backend: "dev",
    otaManifestUrl: otaUrl,
    macPackageVersion: 2,
    macInstaller: "Install Mentra.app",
    mobileFingerprint: "c".repeat(64),
    mobileSourceCommit: "b".repeat(40),
    reusedCompilation: false,
    version: "3.3.0",
    build: "303006291",
    executableSha256: hash("test executable"),
    javascriptSha256: hash("test javascript"),
    profileUUID: "44260d9b-f260-406f-bad7-7119efe321d8",
    profileExpires: "2027-05-28T04:05:18",
    teamId: "T5XXXL6N36",
  }
  const bytes = JSON.stringify(manifest)
  const buildManifest = join(root, "build.json")
  await writeFile(buildManifest, bytes)
  const output = join(root, "evidence")
  await mkdir(output)
  const fixture = {
    usb: "owned-port",
    serial: "TEST012345",
    cid: "0123456789abcdef0123456789abcdef",
    bluetooth: "AA:BB:CC:DD:EE:01",
  }
  const artifact = {url: "https://example.com/artifact", sha256: "d".repeat(64), size: 10}
  const profile: FirmwareProfile = {
    manifest: {...artifact, url: otaUrl},
    asg: {versionCode: 303006291, artifact},
    bes: {version: "26.9.21.3", artifact},
    mtk: {version: "MentraLive_20260921.0", artifact},
  }
  const context = {recorder: new Recorder(output), profile, fixture}
  let page = "home",
    pid = 4242,
    bluetooth = fixture.bluetooth,
    failPress = false,
    audioNotice = false,
    ambiguousNotice = false
  const commands: Command[] = []
  const doctor = (): Doctor => ({
    accessibility: true,
    screenCapture: true,
    postEvents: false,
    pid,
    frontmostBundleId: "com.openai.codex",
    bundleId: manifest.bundleId,
    bundlePath: bundle,
    executablePath: join(bundle, "Mentra"),
    javascriptPath: join(bundle, "main.jsbundle"),
    version: manifest.version,
    build: manifest.build,
  })
  const state = (): Snapshot => ({
    pid,
    frontmostBundleId: "com.openai.codex",
    window: {x: 0, y: 0, width: 400, height: 600},
    elements:
      page === "home"
        ? [
            element({description: "Mentra Live, connected, 100%, ready"}),
            element({identifier: "home.miniapp.com.mentra.settings"}),
            ...(audioNotice
              ? [
                  element({role: "AXGroup"}),
                  element({role: "AXStaticText", description: OTA_AUDIO_NOTICE_TITLE}),
                  element({role: "AXStaticText", description: OTA_AUDIO_NOTICE_BODY}),
                  element({role: "AXButton", description: "Ignore"}),
                  element({role: "AXButton", description: "Connect"}),
                  ...(ambiguousNotice ? [element({role: "AXButton", description: "Ignore"})] : []),
                ]
              : []),
          ]
        : page === "settings"
          ? [element({description: "Device info"}), element({identifier: "miniapp.close"})]
          : [
              element({description: "MAC address, " + bluetooth}),
              element({description: "Build number, 303006291"}),
              element({identifier: "miniapp.close"}),
            ],
  })
  const ui = async <T>(input: Command): Promise<T> => {
    commands.push(input)
    if (input.op === "doctor") return doctor() as T
    if (input.op === "snapshot") return state() as T
    if (input.op === "screenshot") {
      await writeFile(input.path!, png, {flag: "wx"})
      return {width: 1, height: 1, bytes: png.length} as T
    }
    if (input.op === "press") {
      if (failPress) throw new Error("simulated inaccessible control")
      if (input.selector?.description === "Ignore") {
        audioNotice = false
        return {method: "AXPress"} as T
      }
      if (audioNotice) throw new Error("Audio notice blocks navigation")
      page =
        input.selector?.identifier === "home.miniapp.com.mentra.settings"
          ? "settings"
          : input.selector?.identifier === "miniapp.close"
            ? "home"
            : "info"
      return {method: "AXPress"} as T
    }
    throw new Error("Unexpected mock command")
  }
  const observer = appObserver(
    {buildManifest, buildManifestSha256: hash(bytes)},
    {
      ui,
      processStart: async () => "Tue Sep 22 00:00:00 2026",
      driverHash: async () => "e".repeat(64),
      captureScreenshot,
    },
  )
  return {
    observer,
    context,
    root,
    bundle,
    output,
    commands,
    setPid: (value: number) => {
      pid = value
    },
    setBluetooth: (value: string) => {
      bluetooth = value
    },
    failPress: () => {
      failPress = true
    },
    setAudioNotice: (shown: boolean, ambiguous = false) => {
      audioNotice = shown
      ambiguousNotice = ambiguous
    },
  }
}

test("one timed app batch records three owned screenshots and exact selected provenance", async () => {
  const s = await setup()
  await s.observer.prepare(s.context)
  const before = new Date().toISOString()
  const proof = await s.observer.finish(s.context, await s.observer.capture(s.context))
  const now = Date.now()
  const after = new Date(now).toISOString()
  expect(proof.connected).toBe(true)
  expect(appProofWithinBracket(proof, before, after, now)).toBe(true)
  expect((await readdir(join(s.output, "app"))).filter((name) => name.endsWith(".png")).sort()).toEqual([
    "device-info.png",
    "paired-home.png",
    "settings.png",
  ])
  expect(s.commands.filter((entry) => entry.op === "press")).toHaveLength(3)
  expect(s.commands.filter((entry) => entry.op === "screenshot")).toHaveLength(3)
  expect(s.commands.every((entry) => ["doctor", "snapshot", "press", "screenshot"].includes(entry.op))).toBe(true)
  const provenance = JSON.parse(await readFile(join(s.output, "app/provenance-after.json"), "utf8"))
  expect(provenance.executableSha256).toBe(hash("test executable"))
  expect(provenance.verified.verifiedCiBuild.headSha).toBe("a".repeat(40))
  const observed = {
    ...s.context.fixture,
    at: after,
    evidence: proof.evidence,
    bootId: "da1ae189-2166-4d4b-8069-806e570bb530",
    bootCompleted: true,
    firmware: "MentraLive_20260921.0",
    asgVersion: 303006291,
    activeApkSha256: "d".repeat(64),
    updateIdle: true,
    appConnected: appProofWithinBracket(proof, before, after, now),
    bes: {
      version: "26.9.21.3",
      at: after,
      bootId: "da1ae189-2166-4d4b-8069-806e570bb530",
      evidence: "simulated-hardware-proof",
    },
  }
  const assertions = assertFirmwareState(
    s.context.profile,
    {...s.context.fixture, serials: [s.context.fixture.serial]},
    observed,
    now,
  )
  expect(assertions).toHaveLength(14)
  expect(assertions.filter((row) => row.status !== "passed")).toEqual([])
  const stale = {...proof, capturedAt: [new Date(now - 30001).toISOString(), ...proof.capturedAt]}
  expect(appProofWithinBracket(stale, before, after, now)).toBe(false)
  expect(
    appProofWithinBracket(
      {...proof, capturedAt: [new Date(now + 1).toISOString(), ...proof.capturedAt]},
      before,
      after,
      now,
    ),
  ).toBe(false)
})

test("another paired MAC remains a failed connection proof after returning home", async () => {
  const s = await setup()
  await s.observer.prepare(s.context)
  s.setBluetooth("AA:BB:CC:DD:EE:02")
  const proof = await s.observer.finish(s.context, await s.observer.capture(s.context))
  expect(proof.connected).toBe(false)
})

test("an owned video capture hook replaces standalone screenshots and retains image metadata and timing", async () => {
  const paths: string[] = []
  const s = await setup(async (path) => {
    paths.push(path)
    await writeFile(path, png, {flag: "wx"})
    return {width: 1, height: 1, bytes: png.length, frameTime: 1.5, observationAgeSeconds: 0.1, settled: true}
  })
  await s.observer.prepare(s.context)
  const before = new Date().toISOString()
  const proof = await s.observer.finish(s.context, await s.observer.capture(s.context))
  const now = Date.now()
  expect(appProofWithinBracket(proof, before, new Date(now).toISOString(), now)).toBe(true)
  expect(paths).toEqual(["settings", "device-info", "paired-home"].map((name) => join(s.output, "app", name + ".png")))
  expect(s.commands.filter((entry) => entry.op === "screenshot")).toHaveLength(0)
  const screenshot = JSON.parse(await readFile(join(s.output, "app/paired-home.json"), "utf8")).screenshot
  expect(screenshot).toMatchObject({bytes: png.length, frameTime: 1.5, observationAgeSeconds: 0.1, settled: true})
  const journal = (await readFile(join(s.output, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row))
  const captures = journal.filter((row) => row.captureSource === "caller-screenshot-hook")
  expect(captures).toHaveLength(3)
  expect(captures.every((row) => !row.argv && row.request.op === "screenshot")).toBe(true)
})

test("failed or malformed injected screenshots never retry or fall back to native capture", async () => {
  for (const malformed of [false, true]) {
    let calls = 0
    const s = await setup(async (path) => {
      calls++
      if (!malformed) throw new Error("owned video capture failed")
      await writeFile(path, png, {flag: "wx"})
      return {width: 1, height: 1, bytes: png.length + 1}
    })
    await s.observer.prepare(s.context)
    await expect(s.observer.capture(s.context)).rejects.toThrow(
      malformed ? "bytes/dimensions" : "owned video capture failed",
    )
    expect(calls).toBe(1)
    expect(s.commands.filter((entry) => entry.op === "screenshot")).toHaveLength(0)
  }
})

test("process replacement or changed app bytes cannot inherit the earlier proof", async () => {
  const s = await setup()
  await s.observer.prepare(s.context)
  const proof = await s.observer.capture(s.context)
  s.setPid(4243)
  await expect(s.observer.finish(s.context, proof)).rejects.toThrow("process or paths changed")
  const t = await setup()
  await t.observer.prepare(t.context)
  const other = await t.observer.capture(t.context)
  await writeFile(join(t.bundle, "main.jsbundle"), "replacement javascript")
  await expect(t.observer.finish(t.context, other)).rejects.toThrow("does not match")
})

test("a navigation failure records the error and never retries its press", async () => {
  const s = await setup()
  await s.observer.prepare(s.context)
  s.failPress()
  await expect(s.observer.capture(s.context)).rejects.toThrow("simulated inaccessible control")
  expect(s.commands.filter((entry) => entry.op === "press")).toHaveLength(1)
  expect(await readFile(join(s.output, "commands.jsonl"), "utf8")).toContain("app-command-error")
})

test("actual packaged OTA configuration must match the supplied frozen manifest", async () => {
  const s = await setup()
  await writeFile(
    join(s.bundle, "EXConstants.bundle/app.config"),
    JSON.stringify({extra: {mentraPrBuild: {otaManifestUrl: "https://example.com/other.json"}}}),
  )
  await expect(s.observer.prepare(s.context)).rejects.toThrow("different OTA manifest pin")
})

test("the exact optional audio notice is recorded and dismissed once before Settings", async () => {
  const s = await setup()
  s.setAudioNotice(true)
  await s.observer.prepare(s.context)
  const proof = await s.observer.capture(s.context)
  expect(proof.connected).toBe(true)
  const presses = s.commands.filter((entry) => entry.op === "press")
  expect(presses).toHaveLength(4)
  expect(presses[0].selector).toEqual({role: "AXButton", description: "Ignore", enabled: true})
  expect(presses[1].selector?.identifier).toBe("home.miniapp.com.mentra.settings")
  const step = JSON.parse(await readFile(join(s.output, "app/audio-notice-dismissed.json"), "utf8"))
  expect(step.instruction).toContain("this OTA routine uses the existing app connection")
  expect(await Bun.file(join(s.output, "app/audio-notice-dismissed.png")).exists()).toBe(true)
  s.setAudioNotice(true)
  expect((await s.observer.finish(s.context, proof)).connected).toBe(false)
  expect(s.commands.filter((entry) => entry.op === "press")).toHaveLength(4)
})

test("ambiguous audio notice fails closed and an interrupted Ignore is never replayed", async () => {
  const s = await setup()
  await s.observer.prepare(s.context)
  s.setAudioNotice(true, true)
  await expect(s.observer.capture(s.context)).rejects.toThrow("incomplete or ambiguous")
  expect(s.commands.filter((entry) => entry.op === "press")).toHaveLength(0)
  const t = await setup()
  await t.observer.prepare(t.context)
  t.setAudioNotice(true)
  t.failPress()
  await expect(t.observer.capture(t.context)).rejects.toThrow("simulated inaccessible")
  expect(t.commands.filter((entry) => entry.op === "press")).toHaveLength(1)
})
