import {expect, test} from "bun:test"
import {verifyBuildManifest} from "./build-manifest"

const head = "a".repeat(40)
const buildSha = "b".repeat(40)
const compiled = "c".repeat(40)
const binary = "d".repeat(64)
const javascript = "e".repeat(64)
const running = {
  bundleId: "com.mentra.mentra",
  version: "3.3.0",
  build: "303000123",
  executableSha256: binary,
  javascriptSha256: javascript,
}
const ci = {
  pr: 123,
  headSha: head,
  buildSha,
  runId: 456789,
  runAttempt: 2,
  bundleId: running.bundleId,
  app: "Mentra.app",
  backend: "dev",
  otaManifestUrl: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-123-${head}.json`,
  macPackageVersion: 2,
  macInstaller: "Install Mentra.app",
  mobileFingerprint: "f".repeat(64),
  mobileSourceCommit: buildSha,
  reusedCompilation: false,
  version: running.version,
  build: running.build,
  executableSha256: binary,
  javascriptSha256: javascript,
  profileUUID: "12345678-1234-1234-1234-123456789abc",
  profileExpires: "2027-05-28T04:05:18",
  teamId: "T5XXXL6N36",
}
const local = {
  configuration: "Release",
  bundleId: running.bundleId,
  executableSha256: binary,
  javascriptSha256: javascript,
  sourceStatus: "",
  sourceCommit: compiled,
}

test("CI manifest without a local configuration records compilation and PR provenance separately", () => {
  const result = verifyBuildManifest(ci, running)
  expect(result.verifiedCiBuild).toEqual(ci)
  expect(result.installedAppCommit).toBe(buildSha)
  expect(result).not.toHaveProperty("verifiedLocalBuild")
  expect(result.verifiedCiBuild).not.toHaveProperty("configuration")
  expect(result.verifiedCiBuild).not.toHaveProperty("sourceStatus")
  expect(result.installedAppCommit).not.toBe(head)
})

test("reused CI compilation keeps the original source rather than the packaging build or PR head", () => {
  const reused = {...ci, reusedCompilation: true, mobileSourceCommit: compiled}
  expect(verifyBuildManifest(reused, running)).toEqual({verifiedCiBuild: reused, installedAppCommit: compiled})
})

test("CI running-app checks reject each bundle, version, build and byte mismatch", () => {
  for (const field of ["bundleId", "version", "build", "executableSha256", "javascriptSha256"])
    expect(() => verifyBuildManifest(ci, {...running, [field]: "different"})).toThrow("does not match")
  expect(() => verifyBuildManifest(ci, {...running, javascriptSha256: null})).toThrow("does not match")
  expect(() => verifyBuildManifest(ci, {...running, executableSha256: null})).toThrow("does not match")
})

test("CI requires exact provenance types, app layout, hashes and a PR-bound OTA pin", () => {
  for (const change of [
    {pr: "123"},
    {pr: 1.5},
    {runId: 0},
    {runId: Number.MAX_SAFE_INTEGER + 1},
    {runAttempt: -1},
    {headSha: "short"},
    {buildSha: "A".repeat(40)},
    {mobileSourceCommit: compiled},
    {mobileFingerprint: "bad"},
    {reusedCompilation: "false"},
    {executableSha256: null},
    {javascriptSha256: ""},
    {bundleId: "other.bundle"},
    {teamId: "other-team"},
    {app: "Other.app"},
    {backend: "prod"},
    {macPackageVersion: 1},
    {macInstaller: "Install.command"},
    {version: null},
    {build: 123},
    {profileUUID: "missing"},
    {profileExpires: "invalid"},
    {otaManifestUrl: ci.otaManifestUrl.replace(head, compiled)},
    {otaManifestUrl: ci.otaManifestUrl + "?latest=true"},
    {otaManifestUrl: "https://artifactscdn.mentraglass.com/firmware_live.json"},
  ])
    expect(() => verifyBuildManifest({...ci, ...change}, running)).toThrow("Invalid CI Mac build manifest")
})

test("partial CI manifests cannot fall back to local Release validation", () => {
  expect(() => verifyBuildManifest({...local, pr: 123}, running)).toThrow("Invalid CI Mac build manifest")
  expect(() => verifyBuildManifest({...ci, configuration: "Release", sourceStatus: ""}, running)).toThrow(
    "Invalid CI Mac build manifest",
  )
  for (const field of Object.keys(ci)) {
    const partial: Record<string, unknown> = {...ci}
    delete partial[field]
    expect(() => verifyBuildManifest(partial, running)).toThrow()
  }
})

test("existing clean and dirty local Release behavior is preserved", () => {
  expect(verifyBuildManifest(local, running)).toEqual({verifiedLocalBuild: local, installedAppCommit: compiled})
  const dirty = {...local, sourceStatus: " M mobile/src/example.ts"}
  expect(verifyBuildManifest(dirty, running)).toEqual({verifiedLocalBuild: dirty, installedAppCommit: null})
  for (const change of [
    {configuration: "Debug"},
    {bundleId: "other"},
    {executableSha256: "other"},
    {javascriptSha256: "other"},
    {javascriptSha256: null},
  ])
    expect(() => verifyBuildManifest({...local, ...change}, running)).toThrow("running Release app")
})

test("build manifest must be an object", () => {
  for (const invalid of [null, [], false, "manifest"])
    expect(() => verifyBuildManifest(invalid, running)).toThrow("Invalid build manifest")
})
