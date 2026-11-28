import {beforeEach, describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"

import {createMiniappConfiguration, type ConfigurationAccount} from "../miniappConfiguration"

const PKG = "com.mentra.documentation"
const ana: ConfigurationAccount = {coreUrl: "https://core.mentra.test", mentraUserId: "mu_ana"}
const bytes = new TextEncoder().encode("a DVI spreadsheet")
const sha256 = createHash("sha256").update(bytes).digest("hex")
const form = {name: "dvi.xlsx", type: "application/vnd.ms-excel", size: bytes.byteLength, sha256}
const manifest = {
  configuration: [
    {key: "defaultMode", type: "string", setBy: ["workspace"], default: "Manual"},
    {key: "modes", type: "list", merge: "append", setBy: ["workspace"], fields: [{key: "name", type: "string"}, {key: "form", type: "file"}]},
  ],
}

let values: Map<string, string>
let blobs: Map<string, Uint8Array>
let served: Uint8Array
let account: ConfigurationAccount | null
let notified: string[]

function make() {
  return createMiniappConfiguration({
    store: () => ({
      getString: (key) => values.get(key),
      set: (key, value) => void values.set(key, value),
      remove: (key) => void values.delete(key),
      getAllKeys: () => [...values.keys()],
    }),
    account: () => account,
    fetchFile: async () => served,
    files: {has: (_pkg, key) => blobs.has(key), store: async (_pkg, key, data) => void blobs.set(key, data)},
    notify: (pkg) => notified.push(pkg),
  })
}

beforeEach(() => {
  values = new Map()
  blobs = new Map()
  served = bytes
  account = ana
  notified = []
})

describe("managed miniapp settings on the phone", () => {
  test("a workspace's values apply once their file is in the blob store, and the miniapp is told", async () => {
    const configuration = make()
    await configuration.setWorkspace(PKG, {defaultMode: "DVI", modes: [{name: "DVI", form}]}, ana)
    expect(blobs.has(`configuration/${sha256}`)).toBe(true)
    expect(notified).toEqual([PKG])
    const merged = configuration.merged(PKG, manifest, {})
    expect(merged.values.defaultMode).toBe("DVI")
    expect(merged.sources.defaultMode).toBe("workspace")
    expect(merged.values.modes).toEqual([{name: "DVI", form, source: "workspace"}])
  })

  test("a file that doesn't match its hash keeps the previous values", async () => {
    served = new TextEncoder().encode("something else")
    const configuration = make()
    await configuration.setWorkspace(PKG, {modes: [{name: "DVI", form}]}, ana)
    expect(configuration.merged(PKG, manifest, {}).values.defaultMode).toBe("Manual")
    expect(notified).toEqual([])
  })

  test("another account signed in reads no workspace values", async () => {
    const configuration = make()
    await configuration.setWorkspace(PKG, {defaultMode: "DVI"}, ana)
    account = {...ana, mentraUserId: "mu_ben"}
    expect(configuration.merged(PKG, manifest, {}).values.defaultMode).toBe("Manual")
  })
})
