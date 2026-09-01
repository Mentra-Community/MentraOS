import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("publishes externally managed streaming on the frozen root API", () => {
  const source = readFileSync(path.join(packageRoot, "src/index.ts"), "utf8")
  const publicObject = source.match(/export const BluetoothSdk:[^=]+=[^\n]+Object\.freeze\(\{([\s\S]*?)\n\}\)/)?.[1]
  const publicEvents = source.match(/const PUBLIC_EVENT_NAMES[^=]+=[^\n]+\[([\s\S]*?)\]\)/)?.[1]

  assert.ok(publicObject, "missing frozen BluetoothSdk public object")
  assert.ok(publicEvents, "missing BluetoothSdk public event allowlist")
  assert.match(publicObject, /startExternallyManagedStream:\s*bindPublicMethod\("startExternallyManagedStream"\)/)
  assert.match(
    publicObject,
    /sendExternallyManagedStreamKeepAlive:\s*bindPublicMethod\("sendExternallyManagedStreamKeepAlive"\)/,
  )
  assert.match(publicEvents, /"keep_alive_ack",/)
})

test("publishes externally managed streaming methods and request types", () => {
  const types = readFileSync(path.join(packageRoot, "src/BluetoothSdk.types.ts"), "utf8")
  const root = readFileSync(path.join(packageRoot, "src/index.ts"), "utf8")

  assert.match(types, /export type StreamKeepAliveRequest =/)
  assert.match(types, /startExternallyManagedStream\(params: StreamStartRequest\): Promise<StreamStatusEvent>/)
  assert.match(types, /sendExternallyManagedStreamKeepAlive\(params: StreamKeepAliveRequest\): Promise<void>/)
  assert.match(types, /keep_alive_ack: KeepAliveAckEvent/)
  assert.match(root, /\bStreamKeepAliveRequest,\n/)
  assert.match(root, /\bKeepAliveAckEvent,\n/)
})

test("keeps the public methods backed by both native bridges", () => {
  const android = readFileSync(
    path.join(packageRoot, "android/src/main/java/com/mentra/bluetoothsdk/BluetoothSdkModule.kt"),
    "utf8",
  )
  const ios = readFileSync(path.join(packageRoot, "ios/BluetoothSdkModule.swift"), "utf8")

  for (const method of ["startExternallyManagedStream", "sendExternallyManagedStreamKeepAlive"]) {
    assert.ok(android.includes(`"${method}"`), `missing Android bridge method: ${method}`)
    assert.ok(ios.includes(`"${method}"`), `missing iOS bridge method: ${method}`)
  }
})
