import {afterAll, beforeAll, describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"
import path from "node:path"

const sdkSingleton = Object.freeze({name: "sdk-singleton"})
const photoReceiverSingleton = Object.freeze({name: "photo-receiver-singleton"})

beforeAll(() => {
  mock.module("@mentra/bluetooth-sdk", () => ({
    default: sdkSingleton,
    BluetoothSdk: sdkSingleton,
  }))
  mock.module("@mentra/bluetooth-sdk/photo-receiver", () => ({
    default: photoReceiverSingleton,
  }))
})

afterAll(() => {
  mock.restore()
})

describe("@mentra/engine/bluetooth-sdk", () => {
  test("preserves the direct SDK singleton identity", async () => {
    const facade = await import("../index")

    expect(facade.default).toBe(sdkSingleton)
    expect(facade.BluetoothSdk).toBe(sdkSingleton)
    expect(facade.default).toBe(facade.BluetoothSdk)
  })

  test("preserves the photo receiver default export", async () => {
    const facade = await import("../photo-receiver")

    expect(facade.default).toBe(photoReceiverSingleton)
  })

  test("publishes every supported SDK facade with source, declaration, and default conditions", () => {
    const packagePath = path.resolve(import.meta.dir, "../../../package.json")
    const packageManifest = JSON.parse(readFileSync(packagePath, "utf8"))
    const expected = {
      "./bluetooth-sdk": "index",
      "./bluetooth-sdk/react": "react",
      "./bluetooth-sdk/types": "types",
      "./bluetooth-sdk/photo-receiver": "photo-receiver",
      "./bluetooth-sdk/debug": "debug",
    }

    for (const [subpath, file] of Object.entries(expected)) {
      expect(packageManifest.exports[subpath]).toEqual({
        "types": `./build/bluetooth-sdk/${file}.d.ts`,
        "react-native": `./src/bluetooth-sdk/${file}.ts`,
        "default": `./build/bluetooth-sdk/${file}.js`,
      })
    }

    expect(packageManifest.exports["./bluetooth-sdk/internal"]).toBeUndefined()
  })
})
