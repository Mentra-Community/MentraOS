import assert from "node:assert/strict"
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  DEFAULT_RN_GIT_PODS,
  buildPodInstallEnv,
  collectRnGitPodDrift,
  computePodFingerprint,
  fileUrlForPath,
  firstPartyPodspecs,
  gitInsteadOfPairs,
  gitUrlVariants,
  githubArchiveUrl,
  isTransientPodInstallError,
  podInstallReason,
  runPodInstall,
  runPodInstallIfNeeded,
} from "./cocoapods-install.mjs"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const MOBILE_ROOT = path.resolve(SCRIPT_DIR, "..")

/** A minimal prebuilt mobile/ tree whose Pods are already in sync. */
async function makeSyncedProject() {
  const root = await mkdtemp(path.join(tmpdir(), "mentra-pod-gate-"))
  const iosDir = path.join(root, "ios")
  await mkdir(path.join(iosDir, "Pods"), {recursive: true})
  await mkdir(path.join(root, "modules", "acs-meeting", "ios"), {recursive: true})
  await writeFile(path.join(root, "package.json"), '{"name":"mentra"}')
  await writeFile(path.join(root, "bun.lock"), "lock")
  await writeFile(path.join(root, "modules", "acs-meeting", "ios", "AcsMeeting.podspec"), "spec")
  await writeFile(path.join(iosDir, "Podfile"), "platform :ios")
  await writeFile(path.join(iosDir, "Podfile.lock"), "PODS: []")
  await writeFile(path.join(iosDir, "Pods", "Manifest.lock"), "PODS: []")
  const stamp = path.join(iosDir, "Pods", ".mentra-pod-install.stamp")
  await writeFile(stamp, `${await computePodFingerprint({iosDir, projectRoot: root})}\n`)
  return {root, iosDir, cleanup: () => rm(root, {recursive: true, force: true})}
}

test("builds the GitHub tag archive URL CocoaPods should have used", () => {
  assert.equal(
    githubArchiveUrl("https://github.com/facebook/folly.git", "v2024.11.18.00"),
    "https://github.com/facebook/folly/archive/refs/tags/v2024.11.18.00.tar.gz",
  )
  assert.equal(
    githubArchiveUrl("https://github.com/fmtlib/fmt.git", "12.1.0"),
    "https://github.com/fmtlib/fmt/archive/refs/tags/12.1.0.tar.gz",
  )
})

test("rewrites both .git and bare GitHub clone URLs to the local mirror", () => {
  const localPath = "/tmp/mentra-cocoapods-mirrors/folly-v2024.11.18.00"
  const pairs = gitInsteadOfPairs("https://github.com/facebook/folly.git", localPath)
  const values = pairs.map((pair) => pair.value).sort()
  assert.deepEqual(values, [
    "https://github.com/facebook/folly",
    "https://github.com/facebook/folly.git",
  ])
  assert.ok(pairs.every((pair) => pair.key === `url.${fileUrlForPath(localPath)}.insteadOf`))
})

test("covers boost's missing .git suffix", () => {
  assert.deepEqual(gitUrlVariants("https://github.com/react-native-community/boost-for-react-native").sort(), [
    "https://github.com/react-native-community/boost-for-react-native",
    "https://github.com/react-native-community/boost-for-react-native.git",
  ])
})

test("pod install env forces HTTP/1.1 and file:// insteadOf without touching global gitconfig", () => {
  const env = buildPodInstallEnv({
    mirrors: [
      {
        git: "https://github.com/facebook/folly.git",
        localPath: "/tmp/mirrors/folly",
      },
    ],
    env: {PATH: "/usr/bin", HOME: "/tmp"},
  })

  assert.equal(env.PATH, "/usr/bin")
  assert.equal(env.GIT_TERMINAL_PROMPT, "0")
  const count = Number(env.GIT_CONFIG_COUNT)
  assert.ok(count >= 6)

  const pairs = []
  for (let i = 0; i < count; i++) {
    pairs.push({key: env[`GIT_CONFIG_KEY_${i}`], value: env[`GIT_CONFIG_VALUE_${i}`]})
  }
  assert.ok(pairs.some((pair) => pair.key === "http.version" && pair.value === "HTTP/1.1"))
  assert.ok(pairs.some((pair) => pair.key === "http.postBuffer" && pair.value === "524288000"))
  assert.ok(
    pairs.some(
      (pair) =>
        pair.key === `url.${fileUrlForPath("/tmp/mirrors/folly")}.insteadOf` &&
        pair.value === "https://github.com/facebook/folly.git",
    ),
  )
})

test("detects the Folly git clone timeout from the user's pod install log", () => {
  assert.equal(
    isTransientPodInstallError({
      message: [
        "Error installing RCT-Folly",
        "error: RPC failed; curl 56 Recv failure: Operation timed out",
        "fatal: early EOF",
        "fatal: fetch-pack: invalid index-pack output",
      ].join("\n"),
    }),
    true,
  )
  assert.equal(isTransientPodInstallError({message: "No podspec found for MapboxNavigationCore"}), false)
})

test("retries pod install after a transient failure and reuses the prefetched mirrors", async () => {
  const calls = []
  let attempts = 0
  await runPodInstall({
    cwd: "/tmp/ios",
    extraArgs: ["--verbose"],
    env: {HOME: "/tmp"},
    attempts: 3,
    baseDelayMs: 0,
    prefetch: async () => [{git: "https://github.com/facebook/folly.git", localPath: "/tmp/mirrors/folly"}],
    run: async (command, args, options) => {
      calls.push({command, args, options})
      if (command === "pod") {
        attempts += 1
        if (attempts === 1) {
          throw new Error("Error installing RCT-Folly\nerror: RPC failed; curl 56 Recv failure: Operation timed out")
        }
      }
    },
  })

  assert.equal(attempts, 2)
  assert.deepEqual(calls[0].args, ["install", "--verbose"])
  assert.equal(calls[0].options.cwd, "/tmp/ios")
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, "0")
  const count = Number(calls[0].options.env.GIT_CONFIG_COUNT)
  const insteadOf = Array.from({length: count}, (_, i) => ({
    key: calls[0].options.env[`GIT_CONFIG_KEY_${i}`],
    value: calls[0].options.env[`GIT_CONFIG_VALUE_${i}`],
  })).find((pair) => pair.value === "https://github.com/facebook/folly.git")
  assert.ok(insteadOf?.key.startsWith("url.file:///tmp/mirrors/folly.insteadOf"))
})

test("installed React Native 0.83 podspecs still match the mirrored git tags", async () => {
  const helpersRb = await readFile(
    path.join(MOBILE_ROOT, "node_modules/react-native/scripts/cocoapods/helpers.rb"),
    "utf8",
  )
  const podspecNames = [
    "RCT-Folly.podspec",
    "boost.podspec",
    "glog.podspec",
    "fmt.podspec",
    "fast_float.podspec",
    "DoubleConversion.podspec",
  ]
  const podspecs = Object.fromEntries(
    await Promise.all(
      podspecNames.map(async (name) => [
        name,
        await readFile(path.join(MOBILE_ROOT, "node_modules/react-native/third-party-podspecs", name), "utf8"),
      ]),
    ),
  )

  assert.deepEqual(collectRnGitPodDrift(DEFAULT_RN_GIT_PODS, {helpersRb, podspecs}), [])
})

test("skips pod install when the Pods tree already matches its inputs", async () => {
  const {root, iosDir, cleanup} = await makeSyncedProject()
  try {
    assert.equal(await podInstallReason({iosDir, projectRoot: root}), null)
    let ran = false
    const result = await runPodInstallIfNeeded({
      cwd: "ios",
      projectRoot: root,
      prefetch: async () => [],
      run: async () => {
        ran = true
      },
    })
    assert.equal(result.skipped, true)
    assert.equal(ran, false, "pod install must not run when nothing changed")
  } finally {
    await cleanup()
  }
})

test("MENTRA_POD_INSTALL=force still installs over a matching stamp", async () => {
  const {root, cleanup} = await makeSyncedProject()
  try {
    let ran = false
    const result = await runPodInstallIfNeeded({
      cwd: "ios",
      projectRoot: root,
      force: true,
      prefetch: async () => [],
      run: async () => {
        ran = true
      },
    })
    assert.equal(result.skipped, false)
    assert.equal(ran, true)
  } finally {
    await cleanup()
  }
})

test("reinstalls when a first-party podspec changes, then stamps the new fingerprint", async () => {
  const {root, iosDir, cleanup} = await makeSyncedProject()
  try {
    const podspec = path.join(root, "modules", "acs-meeting", "ios", "AcsMeeting.podspec")
    assert.deepEqual(await firstPartyPodspecs(root), [podspec])

    await writeFile(podspec, "spec # edited a script phase")
    const reason = await podInstallReason({iosDir, projectRoot: root})
    assert.match(reason, /podspec/)

    let podCalls = 0
    await runPodInstallIfNeeded({
      cwd: "ios",
      projectRoot: root,
      prefetch: async () => [],
      run: async (command) => {
        if (command === "pod") podCalls += 1
      },
    })
    assert.equal(podCalls, 1)
    // The stamp is written from post-install state, so the next run is a no-op.
    assert.equal(await podInstallReason({iosDir, projectRoot: root}), null)
  } finally {
    await cleanup()
  }
})

test("reinstalls when Podfile.lock and Manifest.lock disagree or the stamp is absent", async () => {
  const {root, iosDir, cleanup} = await makeSyncedProject()
  try {
    await writeFile(path.join(iosDir, "Pods", "Manifest.lock"), "PODS: [Sentry]")
    assert.match(await podInstallReason({iosDir, projectRoot: root}), /disagree/)

    await writeFile(path.join(iosDir, "Pods", "Manifest.lock"), "PODS: []")
    await rm(path.join(iosDir, "Pods", ".mentra-pod-install.stamp"))
    assert.match(await podInstallReason({iosDir, projectRoot: root}), /stamp/)

    await rm(path.join(iosDir, "Pods", "Manifest.lock"))
    assert.match(await podInstallReason({iosDir, projectRoot: root}), /Manifest\.lock is missing/)
  } finally {
    await cleanup()
  }
})
