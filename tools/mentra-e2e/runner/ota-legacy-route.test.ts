import {afterEach, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  legacyAppPairChecks,
  verifyPublishedLegacyManifests,
  loadLegacyRoute,
  type FrozenFile,
  type LegacyRoute,
  type LegacyRouteSelection,
} from "./ota-legacy-route"

const folders: string[] = []
afterEach(async () => {
  for (const path of folders.splice(0)) await rm(path, {recursive: true, force: true})
})
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "legacy-route-"))
  folders.push(folder)
  const freeze = async (name: string, text: unknown): Promise<FrozenFile> => {
    const bytes = Buffer.from(typeof text === "string" ? text : JSON.stringify(text))
    const path = join(folder, name)
    await writeFile(path, bytes)
    return {path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}
  }
  const selection: LegacyRouteSelection = {
    buildSha: "a".repeat(40),
    executableSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    manifestUrl: "https://example.test/selected.json",
    beforeAsg: 27,
    beforeFirmware: "20260113",
    targetAsg: 303000001,
    targetFirmware: "20260921.0",
    targetPatches: [{start_firmware: "20260709", end_firmware: "20260921.0"}],
  }
  const asg31 = {...(await freeze("asg31.apk", "asg31")), url: "https://example.test/asg31.apk"}
  const asg37 = {...(await freeze("asg37.apk", "asg37")), url: "https://example.test/asg37.apk"}
  const bes = {...(await freeze("bes.bin", "bes")), url: "https://example.test/bes.bin"}
  const patch = {...(await freeze("patch.zip", "jan-july")), url: "https://example.test/patch.zip"}
  const source = await freeze("policy-source.txt", "reviewed source and APK route evidence")
  const route: LegacyRoute = {
    schemaVersion: 1,
    buildSha: selection.buildSha,
    executableSha256: selection.executableSha256,
    manifestSha256: selection.manifestSha256,
    effectivePolicy: await freeze("policy.json", {
      buildSha: selection.buildSha,
      executableSha256: selection.executableSha256,
      manifestUrl: selection.manifestUrl,
      allowLegacyOtaFallback: true,
      modernOverride: null,
    }),
    sourceEvidence: [source],
    manifests: [
      {
        ...(await freeze("live.json", {versionCode: 31, apkUrl: asg31.url, sha256: asg31.sha256})),
        url: "https://example.test/live.json",
      },
      {
        ...(await freeze("prod.json", {
          apps: {"com.mentra.asg_client": {versionCode: 37, apkUrl: asg37.url, sha256: asg37.sha256}},
          bes_firmware: bes,
          mtk_patches: [
            {start_firmware: "20260113", end_firmware: "20260709", url: patch.url, sha256: patch.sha256},
            {
              start_firmware: "20260204",
              end_firmware: "20260709",
              url: "https://example.test/unrelated.zip",
              sha256: "d".repeat(64),
            },
          ],
        })),
        url: "https://example.test/prod.json",
      },
    ],
    artifacts: [asg31, asg37, bes, patch],
    embeddedAsg: [
      {firmware: "20260709", versionCode: 39, artifact: await freeze("asg39.apk", "asg39"), evidence: source},
    ],
  }
  return {route, selection, freeze}
}

test("derive only the frozen January rescue route; unrelated patches require no artifact", async () => {
  const {route, selection} = await fixture()
  const result = await loadLegacyRoute(route, selection)
  expect(result.allowedFirmware).toEqual(["MentraLive_20260113", "MentraLive_20260709", "MentraLive_20260921.0"])
  expect(result.allowedAsg).toEqual([27, 303000001, 31, 37, 39])
})
test("reject another build, app binary, manifest or disabled effective policy", async () => {
  const {route, selection, freeze} = await fixture()
  for (const key of ["buildSha", "executableSha256", "manifestSha256"] as const)
    await expect(loadLegacyRoute({...route, [key]: "f".repeat(route[key].length)}, selection)).rejects.toThrow(
      "another selected",
    )
  await expect(loadLegacyRoute(route, {...selection, buildSha: ""})).rejects.toThrow("exact selected")
  const policy = JSON.parse(await readFile(route.effectivePolicy.path, "utf8"))
  for (const replacement of [
    {allowLegacyOtaFallback: false},
    {modernOverride: "https://example.test/other"},
    {manifestUrl: "https://example.test/wrong"},
  ])
    await expect(
      loadLegacyRoute(
        {...route, effectivePolicy: await freeze("changed-policy.json", {...policy, ...replacement})},
        selection,
      ),
    ).rejects.toThrow("policy does not permit")
})
test("changed source evidence and manifest bytes fail before authorizing a route", async () => {
  const {route, selection} = await fixture()
  await writeFile(route.sourceEvidence[0].path, "changed")
  await expect(loadLegacyRoute(route, selection)).rejects.toThrow("Frozen file changed")
  const next = await fixture()
  await writeFile(next.route.manifests[0].path, "{}")
  await expect(loadLegacyRoute(next.route, next.selection)).rejects.toThrow("Frozen metadata changed")
})
test("every selected rescue artifact must exist and retain its exact byte hash", async () => {
  const {route, selection} = await fixture()
  await expect(loadLegacyRoute({...route, artifacts: route.artifacts.slice(1)}, selection)).rejects.toThrow(
    "cached legacy artifact",
  )
  await writeFile(route.artifacts[0].path, "changed")
  await expect(loadLegacyRoute(route, selection)).rejects.toThrow("Frozen file changed")
})
test("embedded system ASG needs a permitted firmware and independently retained evidence", async () => {
  const {route, selection} = await fixture()
  await expect(
    loadLegacyRoute({...route, embeddedAsg: [{...route.embeddedAsg[0], firmware: "20260204"}]}, selection),
  ).rejects.toThrow("outside")
  await expect(
    loadLegacyRoute(
      {
        ...route,
        embeddedAsg: [{...route.embeddedAsg[0], evidence: {...route.sourceEvidence[0], sha256: "d".repeat(64)}}],
      },
      selection,
    ),
  ).rejects.toThrow("Frozen file changed")
})
test("source-free route, duplicate endpoint and unhashable rescue artifact cannot authorize an install", async () => {
  const {route, selection, freeze} = await fixture()
  await expect(loadLegacyRoute({...route, sourceEvidence: []}, selection)).rejects.toThrow("reviewed policy")
  await expect(
    loadLegacyRoute({...route, manifests: [route.manifests[0], route.manifests[0]]}, selection),
  ).rejects.toThrow("Duplicate")
  route.manifests[0] = {
    ...(await freeze("bad-manifest.json", {
      versionCode: 31,
      apkUrl: "https://example.test/asg31.apk",
      sha256: "unverified",
    })),
    url: route.manifests[0].url,
  }
  await expect(loadLegacyRoute(route, selection)).rejects.toThrow("lacks SHA-256")
})

test("mutable rescue endpoints are checked byte-for-byte without downloading firmware", async () => {
  const {route} = await fixture()
  const matching = (async (url: unknown) => {
    const reference = route.manifests.find((entry) => entry.url === String(url))!
    return new Response(await readFile(reference.path))
  }) as unknown as typeof fetch
  await expect(verifyPublishedLegacyManifests(route.manifests, matching)).resolves.toBeUndefined()
  const changed = (async () => new Response("changed")) as unknown as typeof fetch
  await expect(verifyPublishedLegacyManifests(route.manifests, changed)).rejects.toThrow("differs")
  const oversized = (async () => new Response("x".repeat(10000))) as unknown as typeof fetch
  await expect(verifyPublishedLegacyManifests(route.manifests, oversized)).rejects.toThrow("size changed")
})
test("legacy UI pair checks use the entire MAC and exact ASG build, never a suffix", () => {
  expect(legacyAppPairChecks("cc:e7:de:e0:03:be", 27)).toEqual([
    {selector: {description: "MAC address, CC:E7:DE:E0:03:BE"}},
    {selector: {description: "Build number, 27"}},
  ])
  expect(() => legacyAppPairChecks("03BE", 27)).toThrow("complete")
  expect(() => legacyAppPairChecks("CC:E7:DE:E0:03:BE", NaN)).toThrow("ASG")
})
