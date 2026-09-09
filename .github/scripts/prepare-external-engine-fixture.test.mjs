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
      dependencies: {"@mentra/engine": "workspace:*", "@mentra/crust": "workspace:*", react: "19.2.0"},
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
  assert.deepEqual(packageJson.dependencies, {react: "19.2.0", "@mentra/engine": "3.1.0-beta.57"})
  assert.deepEqual(packageJson.expo, {})
  const tsconfig = JSON.parse(readFileSync(path.join(output, "tsconfig.json"), "utf8"))
  assert.deepEqual(tsconfig.compilerOptions, {strict: true})
  assert.match(readFileSync(path.join(output, "metro.config.js"), "utf8"), /getDefaultConfig\(__dirname\)/)
  assert.throws(() => readFileSync(path.join(output, "node_modules", "ignored")))
})

test("pins external Engine native peers to the app's verified version", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const readPackage = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"))
  const versions = [
    readPackage("mobile/package.json").dependencies["react-native-zip-archive"],
    readPackage("mobile/modules/engine/package.json").peerDependencies["react-native-zip-archive"],
    readPackage("sdk/example-oem-app/package.json").dependencies["react-native-zip-archive"],
  ]

  assert.match(versions[0], /^\d+\.\d+\.\d+$/)
  assert.equal(new Set(versions).size, 1)
})
