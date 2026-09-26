import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {runInNewContext} from "node:vm"
import {candidateAssets, fingerprintMobile, MOBILE_INPUT_PATHS, MOBILE_PR_PATHS, prBackend, selectMobile} from "./pr-mobile-build.mjs"

const input = {tree: "mobile tree", env: {EXPO_PUBLIC_BUILD_ENV: "dev"}, tools: {node: "20", java: "17"}}
test("configuration-only packaging inputs do not invalidate compiled APK reuse", () => {
  const a = fingerprintMobile(input)
  assert.equal(
    a,
    fingerprintMobile({
      ...input,
      env: {
        ...input.env,
        EXPO_PUBLIC_ASG_OTA_VERSION_URL: "https://ota/new.json",
        MENTRAOS_PINNED_BUILD_NUMBER: "123",
        GITHUB_SHA: "new",
      },
    }),
  )
  assert.notEqual(a, fingerprintMobile({...input, env: {...input.env, EXPO_PUBLIC_BUILD_ENV: "prod"}}))
  assert.notEqual(a, fingerprintMobile({...input, tree: "changed dependency lockfile"}))
  assert.notEqual(a, fingerprintMobile({...input, tools: {...input.tools, java: "21"}}))
})

test("staging-targeted PR binaries are compiled separately and never reuse a dev binary", async () => {
  assert.deepEqual(["dev", "staging", "main", "feature", undefined].map(prBackend), ["dev", "staging", "dev", "dev", "dev"])
  const backend = (name) => ({...input.env, EXPO_PUBLIC_BUILD_ENV: name,
    EXPO_PUBLIC_CLOUD_CORE_URL: `https://core.${name}.us-west-2.mentraglass.com`})
  const dev = fingerprintMobile({...input, env: backend("dev")})
  const staging = fingerprintMobile({...input, env: backend("staging")})
  assert.notEqual(dev, staging)
  // A URL alone also changes the compilation; the backend label cannot drift from it.
  assert.notEqual(staging, fingerprintMobile({...input, env: {...backend("staging"), EXPO_PUBLIC_CLOUD_CORE_URL: "https://core.dev.us-west-2.mentraglass.com"}}))
  const digest = "b".repeat(64)
  const devAssets = [{name: "mobile-pr-1-ccccccc.apk", label: `mobile-v1:${dev}:${digest}`},
    {name: `mentra-ios-iphone-pr-1-${"c".repeat(40)}-2-1.ipa`, label: `mobile-v1:${dev}:${digest}`}]
  for (const platform of ["android", "ios"]) assert.deepEqual(candidateAssets(devAssets, staging, platform), [])
  // Every workflow step after environment setup, including the fingerprint, sees the pinned backend.
  for (const name of ["mentra-app-android-build.yml", "mentra-app-ios-build.yml"]) {
    const workflow = readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
    const selection = workflow.indexOf('case "$GITHUB_BASE_REF" in\n              staging) CLOUD_ENV="staging" ;;\n              *) CLOUD_ENV="dev" ;;')
    assert.ok(selection > 0 && workflow.lastIndexOf('if [ "${{ github.event_name }}" = "pull_request" ]; then', selection) > workflow.indexOf("- name: Setup environment"))
    assert.match(workflow, /case "\$\{\{ github\.ref_name \}\}" in\n\s+main\) CLOUD_ENV="prod" ;;\n\s+\*\) CLOUD_ENV="dev" ;;/)
    assert.ok(workflow.indexOf('echo "EXPO_PUBLIC_BUILD_ENV=$CLOUD_ENV"') < workflow.indexOf("node .github/scripts/pr-mobile-build.mjs"))
    assert.doesNotMatch(workflow, /\$\{\{ github\.(base_ref|event\.pull_request\.base\.ref) \}\}/)
  }
})

test("real git fingerprint inputs exclude glasses sources but include shared mobile sources and lockfiles", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-mobile-tree-"))
  const git = (...args) => execFileSync("git", args, {cwd: root, encoding: "utf8"})
  git("init", "-q")
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
    writeFileSync(path.join(root, file), value)
  }
  write("mobile/src/app.ts", "app")
  write("asg_client/main.java", "asg")
  write("asg_client/ota_manifests/firmware_live.json", "firmware")
  git("add", ".")
  const tree = () => git("ls-tree", "-r", git("write-tree").trim(), "--", ...MOBILE_INPUT_PATHS)
  const original = tree()
  write("asg_client/main.java", "new asg")
  write("asg_client/ota_manifests/firmware_live.json", "new firmware")
  git("add", ".")
  assert.equal(original, tree())
  for (const file of [
    "mobile/bun.lock",
    "cloud-v2/packages/protocol/src/index.ts",
    "android_core/lib.java",
    "package.json",
  ]) {
    const before = tree()
    write(file, "new input")
    git("add", ".")
    assert.notEqual(before, tree())
  }
})

test("reuse requires exact fingerprint and checksum metadata, newest first", () => {
  const fp = "a".repeat(64),
    sha = "b".repeat(64)
  const asset = {name: "mobile-pr-123-abcdef0.apk", label: `mobile-v1:${fp}:${sha}`}
  assert.deepEqual(
    candidateAssets(
      [
        {...asset, id: 1},
        {...asset, id: 2},
        {...asset, id: 3, label: "old"},
        {...asset, id: 4, name: "asg-pr-123-abcdef0.apk"},
      ],
      fp,
    ).map((a) => a.id),
    [2, 1],
  )
})

test("Android triggers are covered by ASG, and PR binaries are not duplicated as Actions artifacts", () => {
  const android = readFileSync(new URL("../workflows/mentra-app-android-build.yml", import.meta.url), "utf8")
  const asg = readFileSync(new URL("../workflows/mentra-asg-client-build.yml", import.meta.url), "utf8")
  const paths = (s) => s.split("    paths:\n")[1].split("\n  push:")[0]
  assert.equal(paths(android), paths(asg))
  assert.match(android, /Upload Release APK \(artifact\)\n        if: github.event_name != 'pull_request'/)
  assert.match(android, /Package this PR's configuration and sign/)
  assert.match(android, /notify-pr-builds:[\s\S]*needs: build/)
})

test("PR comment updates retain previous APK links with either success label", () => {
  const workflow = readFileSync(new URL("../workflows/mentra-app-android-build.yml", import.meta.url), "utf8")
  for (const variable of ["existingShaMatch", "previousShaMatch"]) {
    const expression = workflow.match(new RegExp(`const ${variable} = comment.body.match\\((/.+/)\\)`))[1]
    const pattern = runInNewContext(expression)
    for (const status of ["Ready to test!", "APK published"]) {
      assert.equal(pattern.exec(`✅ **${status}** (commit \`abcdef0\`)`)[1], "abcdef0")
    }
  }
})

test("mobile and ASG progress/failure comments retain both GitHub and CDN download links", () => {
  for (const [file, label] of [
    ["mentra-app-android-build.yml", "Download APK"],
    ["mentra-asg-client-build.yml", "Download ASG APK"],
  ]) {
    const workflow = readFileSync(new URL(`../workflows/${file}`, import.meta.url), "utf8")
    for (const variable of ["existingDownloadMatch", "previousDownloadMatch"]) {
      const expression = workflow.match(new RegExp(`const ${variable} = comment.body.match\\((/.+/)\\)`))[1]
      const pattern = runInNewContext(expression)
      for (const origin of ["github.com", "artifactscdn.mentraglass.com"]) {
        const url = `https://${origin}/Mentra-Community/MentraOS/releases/pr-builds/app.apk`
        assert.equal(pattern.exec(`[📥 **${label}**](${url})`)[1], url)
      }
      assert.equal(pattern.exec(`[📥 **${label}**](https://github.com.example.org/app.apk)`), null)
    }
  }
})

test("iOS and Android never select each other's binaries, and all producer triggers agree", () => {
  const fp = "a".repeat(64),
    digest = "b".repeat(64)
  const assets = [
    {name: `mentra-ios-iphone-pr-1-${"c".repeat(40)}-2-1.ipa`, label: `mobile-v1:${fp}:${digest}`},
    {name: "mobile-pr-1-ccccccc.apk", label: `mobile-v1:${fp}:${digest}`},
  ]
  assert.deepEqual(candidateAssets(assets, fp, "ios"), [assets[0]])
  assert.deepEqual(candidateAssets(assets, fp, "android"), [assets[1]])
  assert.deepEqual(candidateAssets(assets, "d".repeat(64), "ios"), [])
  const paths = (name) =>
    readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
      .split("    paths:\n")[1]
      .split("\n  push:")[0]
      .trim()
  assert.equal(paths("mentra-app-ios-build.yml"), paths("mentra-app-android-build.yml"))
  assert.equal(paths("mentra-asg-client-build.yml"), paths("mentra-app-android-build.yml"))
})

test("every producer trigger path is a shared mobile PR path, and every shared path triggers each producer", () => {
  for (const name of ["mentra-app-android-build.yml", "mentra-app-ios-build.yml", "mentra-asg-client-build.yml"]) {
    const block = readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
      .split("\n  pull_request:\n")[1].split("\n  push:")[0].split("    paths:\n")[1].split("\n")
    // Keep the existing shape: the block is only quoted path entries.
    const triggers = block.map(line => /^      - "([^"]+)"$/.exec(line)?.[1])
    assert.ok(triggers.every(Boolean), `${name} has an unexpected trigger line`)
    assert.deepEqual(triggers.filter(path => !MOBILE_PR_PATHS.includes(path)), [], `${name} triggers paths the notifier ignores`)
    assert.deepEqual(MOBILE_PR_PATHS.filter(path => !triggers.includes(path)), [], `${name} misses shared paths`)
    assert.deepEqual(triggers, MOBILE_PR_PATHS)
  }
  assert.ok(MOBILE_PR_PATHS.includes(".github/scripts/pr-android-artifacts*"))
})

test("iOS selection skips corrupt candidates, verifies signature/provenance and falls back to compilation", async () => {
  const {selectMobile} = await import("./pr-mobile-build.mjs")
  const {createHash} = await import("node:crypto")
  const fp = "a".repeat(64),
    body = Buffer.from("signed app")
  const digest = createHash("sha256").update(body).digest("hex")
  const asset = {id: 1, name: `mentra-ios-iphone-pr-1-${"c".repeat(40)}-2-1.ipa`, label: `mobile-v1:${fp}:${digest}`}
  const directory = mkdtempSync(path.join(tmpdir(), "pr-ios-select-"))
  const previous = process.cwd()
  process.chdir(directory)
  try {
    for (const {valid, unavailableIndex} of [
      {valid: true, unavailableIndex: false},
      {valid: false, unavailableIndex: false},
      {valid: true, unavailableIndex: true},
      {valid: false, unavailableIndex: true},
    ]) {
      const outputs = {},
        verified = []
      const github = {
        rest: {
          repos: {
            getReleaseByTag: async () => ({data: {id: 1}}),
            listReleaseAssets: () => {},
            getReleaseAsset: async ({asset_id}) => ({data: asset_id === 2 ? Buffer.from("corrupt") : body}),
          },
        },
        paginate: async () => [{...asset, id: 2}, asset],
      }
      await selectMobile({
        github,
        context: {repo: {owner: "o", repo: "r"}},
        platform: "ios",
        env: {MENTRA_PR_MOBILE_FINGERPRINT: fp},
        readIndex: async () => {
          if (unavailableIndex) throw Object.assign(new Error("temporary outage"), {code: "ETIMEDOUT"})
          return {assets: []}
        },
        core: {setOutput: (key, value) => (outputs[key] = value), info: () => {}, warning: () => {}},
        exec: (command, args) => {
          verified.push(args)
          if (!valid) throw new Error("wrong signing identity")
        },
      })
      assert.equal(outputs.reused, String(valid))
      assert.equal(verified.length, 1)
      assert.equal(verified[0][0], "mobile/ci/pr-ios/repackage.py")
      assert.equal(verified[0][1], "verify-base")
    }
  } finally {
    process.chdir(previous)
  }
})

function selectionWithoutCandidates(readIndex) {
  const outputs = {},
    warnings = []
  return {
    outputs,
    warnings,
    args: {
      github: {
        rest: {repos: {getReleaseByTag: async () => ({data: {id: 1}}), listReleaseAssets: () => {}}},
        paginate: async () => [],
      },
      context: {repo: {owner: "o", repo: "r"}},
      platform: "ios",
      env: {MENTRA_PR_MOBILE_FINGERPRINT: "a".repeat(64)},
      readIndex,
      core: {
        setOutput: (key, value) => (outputs[key] = value),
        info: () => {},
        warning: (value) => warnings.push(value),
      },
      exec: () => assert.fail("A missing candidate must never be treated as verified"),
    },
  }
}

test("temporary reuse index transport failures fall back to compilation with a sanitized reason", async () => {
  const failures = [
    ...["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EAI_AGAIN"].map((code) =>
      Object.assign(new Error("must not print provider details"), {code}),
    ),
    ...[429, 500, 502, 503, 504].map((httpStatusCode) =>
      Object.assign(new Error("must not print provider details"), {$metadata: {httpStatusCode}}),
    ),
  ]
  for (const failure of failures) {
    const {args, outputs, warnings} = selectionWithoutCandidates(async () => {
      throw failure
    })
    await selectMobile(args)
    assert.equal(outputs.reused, "false")
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Reuse index temporarily unavailable/)
    assert.doesNotMatch(warnings[0], /provider details/)
  }
})

test("reuse index authentication, configuration and malformed-data failures remain fatal", async () => {
  const failures = [
    Object.assign(new Error("denied"), {$metadata: {httpStatusCode: 403}}),
    new Error("ARTIFACTS_R2_ACCOUNT_ID is required"),
    new Error("Artifact index does not match its release"),
    new SyntaxError("Unexpected token"),
  ]
  for (const failure of failures) {
    const {args, outputs, warnings} = selectionWithoutCandidates(async () => {
      throw failure
    })
    await assert.rejects(selectMobile(args), (error) => error === failure)
    assert.equal(outputs.reused, undefined)
    assert.deepEqual(warnings, [])
  }
})
