import assert from "node:assert/strict"
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {prepareExternalEngineFixture} from "./prepare-external-engine-fixture.mjs"

test("removes every monorepo shortcut from the external Engine fixture", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mentra-engine-fixture-"))
  const source = path.join(root, "source")
  const output = path.join(root, "output")
  mkdirSync(source)
  writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      dependencies: {"@mentra/engine": "workspace:*", "@mentra/crust": "workspace:*", "react": "19.2.0"},
      expo: {autolinking: {nativeModulesDir: "../../mobile/modules"}},
    }),
  )
  writeFileSync(
    path.join(source, "tsconfig.json"),
    JSON.stringify({compilerOptions: {strict: true, paths: {"@mentra/engine": ["../../engine"]}}}),
  )
  writeFileSync(path.join(source, "metro.config.js"), "module.exports = {watchFolders: ['/repo']}\n")
  mkdirSync(path.join(source, "node_modules"))
  writeFileSync(path.join(source, "node_modules", "ignored"), "ignored")

  prepareExternalEngineFixture({sourceDir: source, outputDir: output, releaseIdentity: "3.1.0-beta.57"})

  const packageJson = JSON.parse(readFileSync(path.join(output, "package.json"), "utf8"))
  assert.deepEqual(packageJson.dependencies, {"react": "19.2.0", "@mentra/engine": "3.1.0-beta.57"})
  assert.deepEqual(packageJson.expo, {})
  const tsconfig = JSON.parse(readFileSync(path.join(output, "tsconfig.json"), "utf8"))
  assert.deepEqual(tsconfig.compilerOptions, {strict: true})
  assert.match(readFileSync(path.join(output, "metro.config.js"), "utf8"), /getDefaultConfig\(__dirname\)/)
  assert.throws(() => readFileSync(path.join(output, "node_modules", "ignored")))
})

test("pins external Engine native peers to the app's verified version", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const readPackage = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"))
  // react-native-fs 2.41 adds ArrayBuffer specs that RN 0.83 cannot codegen.
  // Fresh registry consumers must not drift beyond the app's tested version.
  for (const name of ["react-native-zip-archive", "@dr.pogodin/react-native-fs"]) {
    const versions = [
      readPackage("mobile/package.json").dependencies[name],
      readPackage("mobile/modules/engine/package.json").peerDependencies[name],
      readPackage("examples/oem-app/package.json").dependencies[name],
    ]

    assert.match(versions[0], /^\d+\.\d+\.\d+$/, name)
    assert.equal(new Set(versions).size, 1, name)
    for (const lockfile of ["mobile/bun.lock", "examples/bun.lock"]) {
      const lockedPackage = `${JSON.stringify(name)}: [${JSON.stringify(`${name}@${versions[0]}`)}`
      assert.ok(readFileSync(path.join(root, lockfile), "utf8").includes(lockedPackage), `${lockfile}: ${name}`)
    }
  }
})

// expo-audio accepts any expo-asset peer; a clean npm host otherwise installs
// the current SDK's asset package ahead of Expo 55's nested dependency.
test("constrains the external Engine asset peer to the mobile Expo SDK", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const readPackage = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"))
  const expected = readPackage("mobile/package.json").dependencies["expo-asset"]
  assert.match(expected, /^~55\.0\.\d+$/)
  assert.equal(readPackage("mobile/modules/engine/package.json").peerDependencies["expo-asset"], expected)
  assert.equal(readPackage("examples/oem-app/package.json").dependencies["expo-asset"], expected)

  const output = path.join(mkdtempSync(path.join(os.tmpdir(), "mentra-engine-asset-fixture-")), "host")
  prepareExternalEngineFixture({
    sourceDir: path.join(root, "examples/oem-app"),
    outputDir: output,
    releaseIdentity: "3.3.0-dev.932",
  })
  assert.equal(JSON.parse(readFileSync(path.join(output, "package.json"), "utf8")).dependencies["expo-asset"], expected)
})

// @dr.pogodin/react-native-fs 2.41.0 declares an `ArrayBuffer` TurboModule type
// that React Native 0.83's codegen rejects, which breaks pod install and the
// Android codegen for any host that resolves it fresh. The app, the Engine peer
// and the OEM example pin one version below it; move all three together when the
// app moves to a React Native whose codegen supports it.
test("pins react-native-fs below the release React Native 0.83 codegen rejects", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const readPackage = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"))
  const specs = [
    readPackage("mobile/package.json").dependencies["@dr.pogodin/react-native-fs"],
    readPackage("mobile/modules/engine/package.json").peerDependencies["@dr.pogodin/react-native-fs"],
    readPackage("examples/oem-app/package.json").dependencies["@dr.pogodin/react-native-fs"],
  ]
  assert.equal(new Set(specs).size, 1, `one react-native-fs version everywhere: ${specs.join(", ")}`)
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(specs[0])
  assert.ok(match, `react-native-fs is pinned to an exact version: ${specs[0]}`)
  const [major, minor] = [Number(match[1]), Number(match[2])]
  assert.ok(major === 2 && minor >= 37 && minor < 41, `react-native-fs ${specs[0]} is below 2.41.0`)
})
