import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("publishes the supported OTA transport entrypoint", () => {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"))
  assert.deepEqual(manifest.exports["./ota-transport"], {
    "react-native": "./src/ota-transport/index.ts",
    "types": "./build/ota-transport/index.d.ts",
    "default": "./build/ota-transport/index.js",
  })

  const source = readFileSync(path.join(packageRoot, "src/ota-transport/index.ts"), "utf8")
  assert.match(source, /export const otaLocalNetwork/)
  assert.match(source, /export const otaServer/)
  assert.doesNotMatch(source, /export \{default as Mentra(LocalNetwork|OtaServer)/)
})

test("keeps restart signals and correlated OTA status on the public root", () => {
  const source = readFileSync(path.join(packageRoot, "src/index.ts"), "utf8")
  for (const required of [
    '"glasses_session_changed"',
    '"mtk_update_complete"',
    "queryOtaStatus",
    "subscribeGlassesStatus",
    "subscribeBluetoothStatus",
    "setSystemTime",
    "ping",
  ]) {
    assert.ok(source.includes(required), `missing public OTA primitive: ${required}`)
  }
  assert.match(source, /Unsupported BluetoothSdk event/)
})
