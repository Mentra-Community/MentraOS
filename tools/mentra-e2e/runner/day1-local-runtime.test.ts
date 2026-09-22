import {expect, test} from "bun:test"
import {chmod, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {main} from "../day1-local"
import {root} from "./driver"
import {file, hash, reference} from "./day1-local-io"
import {loadLocalConfig, verifyLocalAdmission, productRestoreBaseline, type LocalConfig} from "./day1-local-runtime"
import {runLifecycle} from "./lifecycle"

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "day1-local-admission-"))
  try {
    await body(await setup(folder))
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}
async function setup(folder: string) {
  const freeze = async (name: string, value: unknown) => {
    const path = join(folder, name)
    await writeFile(path, JSON.stringify(value) + "\n", {mode: 0o600})
    return reference(path)
  }
  const binding = {
    definitionDigest: "a".repeat(64),
    returnProfileDigest: "b".repeat(64),
    requestSha256: "c".repeat(64),
    sourceProfileDigests: ["d".repeat(64)],
  }
  const fixtureDirectory = join(folder, "fixture"),
    runDirectory = join(folder, "enrollment")
  const observation = async () => ({
    passed: true,
    expected: "Synthetic unit-test enrollment",
    actual: "Synthetic unit-test enrollment",
    observedAt: new Date().toISOString(),
    source: "Unit test; no devices",
    evidence: [join(folder, "synthetic.json")],
  })
  // Produce the real lifecycle terminal file shape. This is a synthetic test
  // enrollment, not fabricated lab evidence or a consumed CI request.
  await runLifecycle({
    runDirectory,
    fixtureDirectory,
    selection: {
      runID: "unit-enrollment",
      fixtureID: "unit-fixture",
      returnProfileDigest: binding.sourceProfileDigests[0],
      inputs: null,
    },
    acquireLease: async () => async () => {},
    routine: {
      id: "unit-enrollment",
      definitionDigest: binding.definitionDigest,
      preflight: [{id: "preflight", kind: "assertion", instruction: "Synthetic preflight", observe: observation}],
      setup: [],
      test: [],
      finalAssertions: [{id: "final", kind: "assertion", instruction: "Synthetic final", observe: observation}],
      teardown: [],
      returnVerification: [{id: "return", kind: "assertion", instruction: "Synthetic return", observe: observation}],
      evidence: [{id: "evidence", kind: "assertion", instruction: "Synthetic evidence", observe: observation}],
    },
  })
  const ref = await freeze("synthetic.json", {testOnly: true})
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {cwd: root}).stdout.toString().trim()
  const packet = {
    schemaVersion: 1,
    kind: "authorized-lab-qualification",
    fullRoutinePassed: false,
    routineId: "day1-ota",
    ...binding,
    enrolledSourceProfileDigest: binding.sourceProfileDigests[0],
    fixtureID: "unit-fixture",
    harnessRevision: revision,
    unsupportedLegacyState: "quarantine-no-restoration",
    restoreScope: "selected-mtk-and-gated-product-ota",
    evidence: ["source-validation", "firmware-artifacts", "native-components", "selected-full-ota"].map((kind) => ({
      kind,
      ...ref,
    })),
  }
  const config: LocalConfig = {
    schemaVersion: 1,
    repositoryRoot: root,
    stateDirectory: join(folder, "worker"),
    fixtureDirectory,
    fixtureID: "unit-fixture",
    request: ref,
    trust: ref,
    selection: ref,
    runtimeInputs: ref,
    admission: await freeze("admission.json", packet),
  }
  return {folder, binding, packet, config, freeze, ref, runDirectory}
}

test("file-only admission accepts an enrolled source distinct from the selected return profile", () =>
  fixture(async (f) => {
    const accepted = await verifyLocalAdmission(f.config, f.binding)
    expect(accepted.returnProfileDigest).toBe(f.binding.returnProfileDigest)
    expect(accepted.qualificationDigest).toBe(f.config.admission.sha256)
    expect(f.packet.fullRoutinePassed).toBe(false)
    expect(
      JSON.parse(await readFile(join(f.config.fixtureDirectory, "fixture.json"), "utf8")).returnProfileDigest,
    ).toBe(f.binding.sourceProfileDigests[0])
  }))

test("admission rejects a prior-pass claim, mismatched source, missing evidence, or hidden restoration limits", () =>
  fixture(async (f) => {
    for (const change of [
      {fullRoutinePassed: true},
      {enrolledSourceProfileDigest: "f".repeat(64)},
      {definitionDigest: "e".repeat(64)},
      {evidence: []},
      {restoreScope: "all-firmware-restored"},
    ]) {
      f.config.admission = await f.freeze("admission.json", {...f.packet, ...change})
      await expect(verifyLocalAdmission(f.config, f.binding)).rejects.toThrow()
    }
  }))

test("missing or recovery-required fixture never admits a new hardware run", () =>
  fixture(async (f) => {
    const path = join(f.config.fixtureDirectory, "fixture.json")
    const current = JSON.parse(await readFile(path, "utf8"))
    await writeFile(path, JSON.stringify({...current, status: "recovery-required"}))
    await expect(verifyLocalAdmission(f.config, f.binding)).rejects.toThrow("independently enrolled")
    await rm(path)
    await expect(verifyLocalAdmission(f.config, f.binding)).rejects.toThrow()
  }))

test("ready checkpoint cannot substitute for missing, partial or changed final return evidence", () =>
  fixture(async (f) => {
    const events = join(f.runDirectory, "events.jsonl"),
      original = await readFile(events)
    await writeFile(events, original.subarray(0, original.length - 1))
    await expect(verifyLocalAdmission(f.config, f.binding)).rejects.toThrow("Incomplete")
    await writeFile(events, original)
    const resultPath = join(f.runDirectory, "result.json"),
      result = JSON.parse(await readFile(resultPath, "utf8"))
    await writeFile(resultPath, JSON.stringify({...result, returnVerification: "failed"}))
    await expect(verifyLocalAdmission(f.config, f.binding)).rejects.toThrow("completed return")
  }))

test("changed private pins and symlinks reject before parsing or executing commands", () =>
  fixture(async (f) => {
    const ref = await f.freeze("config.json", f.config)
    await expect(loadLocalConfig({...ref, sha256: "0".repeat(64)})).rejects.toThrow("Frozen file changed")
    await chmod(ref.path, 0o644)
    await expect(loadLocalConfig(ref)).rejects.toThrow("Invalid pinned file")
    const link = join(f.folder, "link.json")
    await symlink(ref.path, link)
    await expect(file({...ref, path: link})).rejects.toThrow()
  }))

test("CLI check rejects a foreign checkout without claiming or invoking hardware", () =>
  fixture(async (f) => {
    const config = await f.freeze("config.json", {...f.config, repositoryRoot: f.folder})
    await expect(main(["check", "--config", config.path, "--sha256", config.sha256])).rejects.toThrow(
      "trusted checkout",
    )
    await expect(readFile(join(f.config.stateDirectory, "claims", "request.json"))).rejects.toThrow()
  }))

test("evidence bytes are verified, not just the packet's claimed hashes", () =>
  fixture(async (f) => {
    await writeFile(f.ref.path, JSON.stringify({changed: true}))
    expect(hash(await readFile(f.ref.path))).not.toBe(f.ref.sha256)
    await expect(verifyLocalAdmission(f.config, f.binding)).rejects.toThrow("Frozen file changed")
  }))

test("ready record cannot adopt a completed journal from another fixture or profile", () =>
  fixture(async (f) => {
    const path = join(f.runDirectory, "run.json"),
      original = JSON.parse(await readFile(path, "utf8"))
    for (const change of [
      {fixtureID: "other-fixture"},
      {runID: "other-run"},
      {returnProfileDigest: f.binding.returnProfileDigest},
    ]) {
      await writeFile(path, JSON.stringify({...original, selection: {...original.selection, ...change}}))
      await expect(verifyLocalAdmission(f.config, f.binding)).rejects.toThrow("enrollment selection")
    }
  }))

test("product restoration accepts only selected MTK, eligible versions and independently idle modern source", () => {
  const fixture = {usb: "unit-usb", serial: "UNIT", cid: "a".repeat(32), bluetooth: "AA:BB:CC:DD:EE:FF"}
  const profile = {
    mtk: {version: "MentraLive_20260921.0"},
    bes: {version: "26.9.21.3"},
    asg: {versionCode: 303000001},
  } as import("./firmware-profile").FirmwareProfile
  const source = {
    identity: {...fixture, firmware: profile.mtk.version, bootId: "source-boot", slot: "_a"},
    writersIdle: true,
    engineStatus: "UPDATE_STATUS_IDLE",
    actual: {observation: {bes: {version: "17.26.1.13"}, asgVersion: 303000000}},
  } as unknown as import("./mtk-full-restore").MtkRestoreObservation
  expect(productRestoreBaseline(source, fixture, profile).before.asgVersion).toBe(303000000)
  for (const change of [
    {writersIdle: false},
    {engineStatus: "UPDATED_NEED_REBOOT"},
    {identity: {...source.identity, cid: "b".repeat(32)}},
    {identity: {...source.identity, firmware: "MentraLive_20260709"}},
    {actual: {observation: {bes: {version: "27.1.1.1"}, asgVersion: 303000000}}},
    {actual: {observation: {bes: {version: "17.26.1.13"}, asgVersion: 37}}},
    {actual: {observation: {bes: {version: "17.26.1.13"}, asgVersion: 303000002}}},
  ]) {
    expect(() => productRestoreBaseline({...source, ...change} as any, fixture, profile)).toThrow()
  }
})
