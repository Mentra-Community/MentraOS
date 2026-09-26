import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {createHash} from "node:crypto"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {runInNewContext} from "node:vm"
import {iosReceiptName, validateIosReceipt, publishIosArtifacts} from "./pr-ios-artifacts.mjs"
import {iosInstallationFiles, macInstallPageUrl} from "./pr-ios-artifacts-install.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"
import {validateMacProvisioning} from "../../mobile/scripts/install-ios-mac.mjs"

const coordinates = {pr: 123, sha: "a".repeat(40), runId: 100, attempt: 2}
const receipt = {
  schemaVersion: 1,
  pr: 123,
  headSha: coordinates.sha,
  buildSha: "b".repeat(40),
  runId: 100,
  runAttempt: 2,
  buildAttempt: 1,
  app: {bundleId: "com.mentra.mentra", version: "3.2.1", build: "302018377"},
  artifacts: Object.fromEntries(
    [
      ["iphone", "ipa"],
      ["mac", "zip"],
    ].map(([kind, ext]) => [
      kind,
      {
        name: `mentra-ios-${kind}-pr-123-${coordinates.sha}-100-1.${ext}`,
        size: 10,
        sha256: "c".repeat(64),
      },
    ]),
  ),
}

test("publication rerun identifies original build bytes and current publication attempt", () => {
  assert.equal(validateIosReceipt(receipt, coordinates), receipt.artifacts)
  assert.throws(() => validateIosReceipt(receipt, {...coordinates, attempt: 1}), /different/)
  assert.throws(() => validateIosReceipt(receipt, {...coordinates, runId: 101}), /different/)
  assert.throws(() => validateIosReceipt({...receipt, buildSha: "wrong"}, coordinates), /different/)
  assert.throws(() => iosReceiptName(123, "../bad", 100, 1), /Invalid/)
})

test("native Mac packages require the notarized installer receipt before publication", () => {
  const native = {
    ...receipt,
    app: {...receipt.app, macPackageVersion: 2, macInstaller: "Install Mentra.app"},
    macInstaller: {
      bundleId: "com.mentra.mac-installer",
      teamId: "T5XXXL6N36",
      notarizationStatus: "Accepted",
      notarizationId: "12345678-abcd-1234-abcd-123456789012",
      stapled: true,
    },
  }
  assert.equal(validateIosReceipt(native, coordinates), native.artifacts)
  for (const installer of [
    undefined,
    {...native.macInstaller, teamId: "OTHERTEAM"},
    {...native.macInstaller, bundleId: "com.example.installer"},
    {...native.macInstaller, notarizationStatus: "In Progress"},
    {...native.macInstaller, notarizationId: ""},
    {...native.macInstaller, stapled: false},
  ])
    assert.throws(() => validateIosReceipt({...native, macInstaller: installer}, coordinates), /notarization/)
})

test("Safari install page points through a valid Apple plist to the exact signed IPA", () => {
  const repository = "Mentra-Community/MentraOS"
  const files = iosInstallationFiles(receipt, repository)
  const plist = JSON.parse(
    execFileSync(
      "python3",
      ["-c", "import json,plistlib,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"],
      {input: files.manifest.content, encoding: "utf8"},
    ),
  )
  assert.deepEqual(plist.items, [
    {
      assets: [{kind: "software-package", url: artifactUrl(repository, "pr-builds", receipt.artifacts.iphone.name)}],
      metadata: {
        "bundle-identifier": receipt.app.bundleId,
        "bundle-version": receipt.app.build,
        "kind": "software",
        "title": "Mentra App",
      },
    },
  ])
  const link = files.install.content.match(/href="(itms-services:[^"]+)"/)[1].replaceAll("&amp;", "&")
  const url = new URL(link)
  assert.equal(url.searchParams.get("action"), "download-manifest")
  assert.equal(url.searchParams.get("url"), artifactUrl(repository, "pr-builds", files.manifest.name))
  assert.match(files.install.content, /Safari on your iPhone/)
  assert.match(files.install.content, /302018377/)
  assert.doesNotMatch(files.install.content, /<script|http-equiv="refresh"/i)
  assert.deepEqual(iosInstallationFiles({...receipt, runAttempt: 3}, repository), files)
  for (const app of [{...receipt.app, bundleId: "wrong"}, {...receipt.app, build: "<bad>"}, undefined])
    assert.throws(() => iosInstallationFiles({...receipt, app}, repository), /app identity/)
})

test("native Mac handoff preserves immutable HTML and selects the public receipt attempt", () => {
  const native = {...receipt, app: {...receipt.app, macPackageVersion: 2, macInstaller: "Install Mentra.app"}}
  const repository = "Mentra-Community/MentraOS"
  const files = iosInstallationFiles(native, repository)
  const html = files.install.content
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const policyHash = html.match(/script-src 'sha256-([^']+)'/)[1]
  assert.equal(policyHash, createHash("sha256").update(script).digest("base64"))
  assert.match(html, /data-mentra-mac-install="1"/)
  assert.match(html, /First-time setup/)
  assert.match(html, /without another ZIP in Downloads/)
  assert.doesNotMatch(script, /itms-services|https?:/)
  assert.deepEqual(iosInstallationFiles({...native, runAttempt: 3}, repository), files)

  const pageUrl = artifactUrl(repository, "pr-builds", files.install.name)
  const handoff = new URL(macInstallPageUrl(pageUrl, 3))
  assert.equal(handoff.pathname, new URL(pageUrl).pathname)
  assert.equal(handoff.search, "?platform=mac&attempt=3")
  for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"])
    assert.throws(() => macInstallPageUrl(pageUrl, attempt), /Invalid/)
  assert.throws(() => macInstallPageUrl("http://example.com/install.html", 1), /Invalid/)

  function runPage(search) {
    const elements = {
      "mac-install": {hidden: true, dataset: {number: "123", head: coordinates.sha, run: "100"}},
      "iphone-install": {hidden: false},
      "install-heading": {textContent: "Install the Mentra App"},
      "mac-status": {},
      "mac-install-button": {},
    }
    const opened = []
    runInNewContext(script, {
      URL,
      URLSearchParams,
      window: {location: {search, assign: (url) => opened.push(url)}},
      document: {getElementById: (id) => elements[id]},
    })
    return {elements, opened}
  }
  for (const query of ["", "?platform=iphone", "?attempt=3", "?platform=mac&platform=iphone&attempt=3"])
    assert.deepEqual(runPage(query).opened, [])
  for (const attempt of ["", "0", "-1", "1.5", "01", "9007199254740992", "3&attempt=4", "%22%3E%3Cscript%3E"])
    assert.deepEqual(runPage(`?platform=mac&attempt=${attempt}`).opened, [])
  const result = runPage("?platform=mac&attempt=3&number=999&run=999&head=evil&url=https://example.com")
  assert.equal(result.opened.length, 1)
  const target = new URL(result.opened[0])
  assert.equal(target.protocol, "mentra-install:")
  assert.equal(target.hostname, "pr")
  assert.deepEqual(Object.fromEntries(target.searchParams), {
    number: "123",
    head: coordinates.sha,
    run: "100",
    attempt: "3",
  })
  assert.equal(result.elements["mac-install-button"].href, target.href)
  assert.equal(result.elements["mac-install"].hidden, false)
  assert.equal(result.elements["iphone-install"].hidden, true)
  for (const values of [{pr: '123"><script>evil</script>'}, {headSha: "<script>"}, {runId: "100"}])
    assert.throws(() => iosInstallationFiles({...native, ...values}, repository), /coordinates/)
})

test("publishes installation files before receipt and preserves their bytes on publication-only retry", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "mentra-ios-publish-"))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const input = structuredClone(receipt)
  input.runAttempt = 1
  input.app.mobileFingerprint = "d".repeat(64)
  for (const asset of Object.values(input.artifacts)) {
    const bytes = Buffer.from(asset.name)
    await writeFile(path.join(directory, asset.name), bytes)
    asset.size = bytes.length
    asset.sha256 = createHash("sha256").update(bytes).digest("hex")
  }
  const name = (attempt) => iosReceiptName(123, coordinates.sha, 100, attempt)
  await writeFile(path.join(directory, name(1)), JSON.stringify(input))
  const env = {
    PR_NUMBER: "123",
    PR_HEAD_SHA: coordinates.sha,
    SOURCE_RUN_ID: "100",
    SOURCE_RUN_ATTEMPT: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "Mentra-Community/MentraOS",
  }
  const uploaded = []
  const exec = (command, args) => {
    if (command === "gh") return "999\n"
    const assetName = args[args.indexOf("--name") + 1]
    if (assetName.endsWith(".ipa")) assert.equal(args[args.indexOf("--fingerprint") + 1], input.app.mobileFingerprint)
    else assert.equal(args.includes("--fingerprint"), false)
    uploaded.push(assetName)
    return ""
  }
  await publishIosArtifacts(directory, env, {exec})
  const first = JSON.parse(await readFile(path.join(directory, name(1)), "utf8"))
  assert.equal(first.schemaVersion, 2)
  assert.deepEqual(uploaded, [...Object.values(first.artifacts).map((a) => a.name), name(1)])
  assert.deepEqual(first.artifacts.iphone, input.artifacts.iphone)
  for (const asset of Object.values(first.artifacts)) {
    const bytes = await readFile(path.join(directory, asset.name))
    assert.equal(asset.size, bytes.length)
    assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"))
  }
  await publishIosArtifacts(directory, {...env, GITHUB_RUN_ATTEMPT: "2"}, {exec})
  const retry = JSON.parse(await readFile(path.join(directory, name(2)), "utf8"))
  assert.deepEqual(validateIosReceipt(retry, coordinates), first.artifacts)
  assert.equal(retry.buildAttempt, 1)
  assert.equal(uploaded.at(-1), name(2))
  for (const kind of ["install", "manifest"]) {
    const broken = structuredClone(retry)
    delete broken.artifacts[kind]
    assert.throws(() => validateIosReceipt(broken, coordinates), /artifact set/)
    broken.artifacts[kind] = {...retry.artifacts[kind], name: "unrelated.html"}
    assert.throws(() => validateIosReceipt(broken, coordinates), /Invalid iOS/)
  }
  uploaded.length = 0
  await assert.rejects(
    publishIosArtifacts(
      directory,
      {...env, GITHUB_RUN_ATTEMPT: "3"},
      {
        exec(command, args) {
          const result = exec(command, args)
          if (uploaded.at(-1)?.endsWith(".plist")) throw new Error("Manifest upload failed")
          return result
        },
      },
    ),
    /Manifest upload failed/,
  )
  assert.ok(!uploaded.includes(name(3)))
  uploaded.length = 0
  await writeFile(path.join(directory, input.artifacts.iphone.name), "corrupt")
  await assert.rejects(publishIosArtifacts(directory, env, {exec}), /Handoff bytes/)
  assert.deepEqual(uploaded, [])
})

test("rejects partial or cross-run artifact metadata", () => {
  for (const asset of [
    undefined,
    {...receipt.artifacts.mac, name: "another.zip"},
    {...receipt.artifacts.mac, size: 0},
    {...receipt.artifacts.mac, sha256: ""},
  ])
    assert.throws(
      () => validateIosReceipt({...receipt, artifacts: {...receipt.artifacts, mac: asset}}, coordinates),
      /Invalid/,
    )
})

test("Mac installer rejects expired, malformed and unregistered provisioning before replacement", () => {
  const profile = {ExpirationDate: "2027-01-01T00:00:00Z", ProvisionedDevices: ["registered"]}
  const now = Date.parse("2026-01-01T00:00:00Z")
  validateMacProvisioning(profile, "registered", now)
  assert.throws(() => validateMacProvisioning(profile, "unknown", now), /not in/)
  assert.throws(() => validateMacProvisioning(profile, "registered", Date.parse("2028-01-01")), /expired/)
  assert.throws(() => validateMacProvisioning({...profile, ExpirationDate: "nonsense"}, "registered", now), /expired/)
})
