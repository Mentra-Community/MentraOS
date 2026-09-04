import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  DEFAULT_RN_GIT_PODS,
  buildPodInstallEnv,
  collectRnGitPodDrift,
  fileUrlForPath,
  gitInsteadOfPairs,
  gitUrlVariants,
  githubArchiveUrl,
  isTransientPodInstallError,
  runPodInstall,
} from "./cocoapods-install.mjs"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const MOBILE_ROOT = path.resolve(SCRIPT_DIR, "..")

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
