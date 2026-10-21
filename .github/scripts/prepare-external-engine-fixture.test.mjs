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
      readPackage("sdk/example-oem-app/package.json").dependencies[name],
    ]

    assert.match(versions[0], /^\d+\.\d+\.\d+$/, name)
    assert.equal(new Set(versions).size, 1, name)
    for (const lockfile of ["mobile/bun.lock", "sdk/bun.lock"]) {
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
  assert.equal(readPackage("sdk/example-oem-app/package.json").dependencies["expo-asset"], expected)

  const output = path.join(mkdtempSync(path.join(os.tmpdir(), "mentra-engine-asset-fixture-")), "host")
  prepareExternalEngineFixture({
    sourceDir: path.join(root, "sdk/example-oem-app"),
    outputDir: output,
    releaseIdentity: "3.3.0-dev.932",
  })
  assert.equal(JSON.parse(readFileSync(path.join(output, "package.json"), "utf8")).dependencies["expo-asset"], expected)
})
