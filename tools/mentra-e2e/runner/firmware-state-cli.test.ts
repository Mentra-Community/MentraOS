import {expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

const cli = new URL("../firmware-state.ts", import.meta.url).pathname
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const manifest = {
  apps: {
    "com.mentra.asg_client": {versionCode: 123, apkUrl: "https://no-fetch.invalid/asg.apk", sha256: "a".repeat(64)},
  },
  bes_firmware: {version: "26.9.21.1", url: "https://no-fetch.invalid/bes.bin", sha256: "b".repeat(64)},
  mtk_full_ota: {
    end_firmware: "20260915.0",
    url: "https://no-fetch.invalid/mtk.zip",
    size: 12345,
    sha256: "c".repeat(64),
  },
}
const manifestBytes = Buffer.from(JSON.stringify(manifest))
const identity = {
  usb: "1048576X",
  cid: "1".repeat(32),
  bluetooth: "CC:E7:DE:E0:03:BE",
  serials: ["ML396102B", "0123456789ABCDEF"],
}
function observed() {
  const at = new Date(Date.now() - 100).toISOString()
  const bootId = "d8564fd1-d6ec-4ecb-9f48-b91d7ed41aeb"
  return {
    at,
    evidence: "hardware/observation.json",
    usb: identity.usb,
    cid: identity.cid,
    bluetooth: identity.bluetooth,
    serial: "ML396102B",
    bootId,
    bootCompleted: true,
    firmware: "20260915.0",
    asgVersion: 123,
    activeApkSha256: "a".repeat(64),
    bes: {version: "26.9.21.1", at, bootId, evidence: "hardware/bes-response.log"},
    updateIdle: true,
    appConnected: true,
  }
}

async function command(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {stdout: "pipe", stderr: "pipe"})
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return {code, stdout, stderr}
}

async function fixture(run: (folder: string, freeze: string[], verify: string[]) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "mentra-firmware-cli-"))
  try {
    await writeFile(join(folder, "manifest.json"), manifestBytes)
    await writeFile(join(folder, "fixture.json"), JSON.stringify(identity))
    await writeFile(join(folder, "observation.json"), JSON.stringify(observed()))
    const freeze = [
      "freeze",
      "--manifest",
      join(folder, "manifest.json"),
      "--manifest-url",
      "https://no-fetch.invalid/frozen.json",
      "--manifest-sha256",
      hash(manifestBytes),
      "--output",
      join(folder, "profile.json"),
    ]
    const verify = [
      "verify",
      "--profile",
      join(folder, "profile.json"),
      "--fixture",
      join(folder, "fixture.json"),
      "--observation",
      join(folder, "observation.json"),
      "--output",
      join(folder, "result.json"),
    ]
    await run(folder, freeze, verify)
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}

test("offline CLI freezes exact bytes, then records all expected/actual assertions and input digests", async () => {
  await fixture(async (folder, freeze, verify) => {
    const frozen = await command(freeze)
    expect({code: frozen.code, stderr: frozen.stderr}).toEqual({code: 0, stderr: ""})
    expect(frozen.stderr).toBe("")
    expect(JSON.parse(frozen.stdout)).toMatchObject({mode: "offline-profile-freeze", status: "passed"})
    const profile = JSON.parse(await readFile(join(folder, "profile.json"), "utf8"))
    expect(profile.manifest).toEqual({
      url: "https://no-fetch.invalid/frozen.json",
      sha256: hash(manifestBytes),
      size: manifestBytes.length,
    })
    expect(profile.mtk.version).toBe("MentraLive_20260915.0")
    expect((await stat(join(folder, "profile.json"))).mode & 0o777).toBe(0o600)
    const verified = await command(verify)
    expect(verified.code).toBe(0)
    expect(verified.stderr).toBe("")
    const report = JSON.parse(await readFile(join(folder, "result.json"), "utf8"))
    expect(report.mode).toBe("offline-assertion")
    expect(report.scope).toContain("does not contact hardware")
    expect(report.inputs.profileSha256).toBe(hash(await readFile(join(folder, "profile.json"))))
    expect(report.assertions).toHaveLength(14)
    expect(report.assertions.every((row: {status: string}) => row.status === "passed")).toBe(true)
    expect(report.assertions.find((row: {id: string}) => row.id === "firmware.mtk").actual).toBe("20260915.0")
  })
})

test("profile digest mismatch fails without producing a profile", async () => {
  await fixture(async (folder, freeze) => {
    freeze[freeze.indexOf("--manifest-sha256") + 1] = "d".repeat(64)
    const result = await command(freeze)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("differ from the frozen selection")
    await expect(stat(join(folder, "profile.json"))).rejects.toHaveProperty("code", "ENOENT")
  })
})

test("offline CLI accepts an explicit Wi-Fi fixture without inventing a USB observation", async () => {
  await fixture(async (folder, freeze, verify) => {
    expect((await command(freeze)).code).toBe(0)
    const wifiEndpoint = "192.168.1.186:5555"
    await writeFile(join(folder, "fixture.json"), JSON.stringify({...identity, usb: undefined, wifiEndpoint}))
    await writeFile(join(folder, "observation.json"), JSON.stringify({...observed(), usb: undefined, wifiEndpoint}))
    const result = await command(verify)
    expect({code: result.code, stderr: result.stderr}).toEqual({code: 0, stderr: ""})
    const report = JSON.parse(await readFile(join(folder, "result.json"), "utf8"))
    expect(report.mode).toBe("offline-assertion")
    expect(report.assertions).toHaveLength(14)
    expect(report.assertions.find((row: {id: string}) => row.id === "identity.wifi-endpoint")).toMatchObject({
      expected: wifiEndpoint, actual: wifiEndpoint, status: "passed",
    })
    expect(report.assertions.some((row: {id: string}) => row.id === "identity.usb")).toBe(false)
  })
})

test("a failed state comparison writes evidence and exits nonzero without claiming live verification", async () => {
  await fixture(async (folder, freeze, verify) => {
    expect((await command(freeze)).code).toBe(0)
    await writeFile(
      join(folder, "observation.json"),
      JSON.stringify({...observed(), activeApkSha256: "d".repeat(64), appConnected: false}),
    )
    const result = await command(verify)
    expect(result.code).toBe(1)
    const report = JSON.parse(await readFile(join(folder, "result.json"), "utf8"))
    expect(report.status).toBe("failed")
    expect(report.mode).toBe("offline-assertion")
    expect(JSON.parse(result.stdout).failed).toEqual(["firmware.asg.active-apk", "app.connected"])
  })
})

test("stale observations cannot be made current by running the offline verifier", async () => {
  await fixture(async (folder, freeze, verify) => {
    expect((await command(freeze)).code).toBe(0)
    const state = observed()
    state.at = state.bes.at = "2020-01-01T00:00:00.000Z"
    await writeFile(join(folder, "observation.json"), JSON.stringify(state))
    const result = await command(verify)
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout).failed).toEqual(["observation.fresh", "firmware.bes.fresh"])
  })
})

test("create-exclusive outputs preserve previous profiles and result evidence", async () => {
  await fixture(async (folder, freeze, verify) => {
    expect((await command(freeze)).code).toBe(0)
    const previous = await readFile(join(folder, "profile.json"), "utf8")
    expect((await command(freeze)).code).toBe(1)
    expect(await readFile(join(folder, "profile.json"), "utf8")).toBe(previous)
    await writeFile(join(folder, "result.json"), "previous evidence")
    expect((await command(verify)).code).toBe(1)
    expect(await readFile(join(folder, "result.json"), "utf8")).toBe("previous evidence")
  })
})

test("invalid JSON shapes fail closed before assertion evidence is written", async () => {
  await fixture(async (folder, freeze, verify) => {
    expect((await command(freeze)).code).toBe(0)
    for (const invalid of [
      null,
      [],
      {...observed(), cid: 3},
      {...observed(), updateIdle: "true"},
      {...observed(), bes: []},
      {...observed(), undocumentedOverride: true},
    ]) {
      await writeFile(join(folder, "observation.json"), JSON.stringify(invalid))
      expect((await command(verify)).code).toBe(1)
      await expect(stat(join(folder, "result.json"))).rejects.toHaveProperty("code", "ENOENT")
    }
    await writeFile(join(folder, "observation.json"), JSON.stringify(observed()))
    await writeFile(join(folder, "fixture.json"), JSON.stringify({...identity, serials: "ML396102B"}))
    expect((await command(verify)).code).toBe(1)
    await writeFile(join(folder, "fixture.json"), JSON.stringify(identity))
    await writeFile(join(folder, "profile.json"), JSON.stringify({asg: 123}))
    expect((await command(verify)).code).toBe(1)
  })
})

test("unknown or duplicate arguments are rejected rather than selecting a different manifest", async () => {
  await fixture(async (_folder, freeze) => {
    expect((await command([...freeze, "--manifest-sha256", "e".repeat(64)])).stderr).toContain("Duplicate")
    expect((await command([...freeze, "--install"])).code).toBe(1)
    expect((await command(["run", ...freeze.slice(1)])).code).toBe(1)
  })
})

test("oversized input is rejected before parsing or output creation", async () => {
  await fixture(async (folder, freeze) => {
    await writeFile(join(folder, "manifest.json"), Buffer.alloc(4 * 1024 * 1024 + 1))
    const result = await command(freeze)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("at most 4 MiB")
    await expect(stat(join(folder, "profile.json"))).rejects.toHaveProperty("code", "ENOENT")
  })
})
