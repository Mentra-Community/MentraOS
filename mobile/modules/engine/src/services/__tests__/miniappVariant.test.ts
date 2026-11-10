import {afterEach, describe, expect, test} from "bun:test"

import {configure, resetForTests} from "../../runtime/bootstrap"
import {isVoiceCallPackage} from "../micPolicy"
import {honoredMiniappVariant, parseMiniappVariant, variantConfiguration} from "../miniappVariant"

const STAMP = {of: "com.mentra.call", backendUrl: "https://call.acme.example"}
const MANAGED = {
  source: "deployment_manifest",
  bundleSha256: "ABC",
  deploymentId: "acme",
  deploymentOrigin: "https://workspace.acme.example",
}

function workspace(): void {
  configure({
    auth: {},
    config: {
      localMiniappPolicy: {
        systemPackageNames: ["com.mentra.settings"],
        managed: [
          {
            packageName: "com.acme.call",
            version: "2.1.62",
            sha256: "abc",
            deploymentId: "acme",
            deploymentOrigin: "https://workspace.acme.example",
          },
        ],
      },
    },
  })
}

describe("miniapp variants", () => {
  afterEach(() => resetForTests())

  test("reads only a well-formed stamp", () => {
    expect(parseMiniappVariant(STAMP)).toEqual(STAMP)
    expect(parseMiniappVariant({of: "com.mentra.call"})).toEqual({of: "com.mentra.call"})
    for (const stamp of [
      undefined,
      "com.mentra.call",
      [],
      {of: "call"},
      {of: "com.mentra.call", backendUrl: "http://call.acme.example"},
      {of: "com.mentra.call", backendUrl: "https://call.acme.example/?token=x"},
      {of: "com.mentra.call", backendUrl: 42},
    ]) {
      expect(parseMiniappVariant(stamp)).toBeUndefined()
    }
  })

  test("honors a stamp only on the release the deployment manages", () => {
    workspace()
    expect(honoredMiniappVariant("com.acme.call", "2.1.62", STAMP, MANAGED)).toEqual(STAMP)
    // Another version, digest, deployment or install source carries no trust.
    expect(honoredMiniappVariant("com.acme.call", "2.1.63", STAMP, MANAGED)).toBeUndefined()
    expect(honoredMiniappVariant("com.acme.call", "2.1.62", STAMP, {...MANAGED, bundleSha256: "def"})).toBeUndefined()
    expect(honoredMiniappVariant("com.acme.call", "2.1.62", STAMP, {...MANAGED, deploymentId: "other"})).toBeUndefined()
    expect(honoredMiniappVariant("com.acme.call", "2.1.62", STAMP, {source: "direct_download"})).toBeUndefined()
    expect(honoredMiniappVariant("com.acme.call", "2.1.62", STAMP, null)).toBeUndefined()
    // A consumer phone has no managed releases at all.
    resetForTests()
    configure({auth: {}})
    expect(honoredMiniappVariant("com.acme.call", "2.1.62", STAMP, MANAGED)).toBeUndefined()
  })

  test("hands the stamped backend to the bundle over the manifest's configuration", () => {
    expect(variantConfiguration({backendUrl: "https://elsewhere.example", region: "eu"}, STAMP)).toEqual({
      backendUrl: "https://call.acme.example",
      region: "eu",
    })
    expect(variantConfiguration({region: "eu"}, {of: "com.mentra.call"})).toEqual({region: "eu"})
    expect(variantConfiguration({region: "eu"}, undefined)).toEqual({region: "eu"})
  })

  test("lets a variant of Mentra Call make voice calls, and nothing else", () => {
    expect(isVoiceCallPackage("com.mentra.call")).toBe(true)
    expect(isVoiceCallPackage("com.acme.call")).toBe(false)
    expect(isVoiceCallPackage("com.acme.call", "com.mentra.call")).toBe(true)
    expect(isVoiceCallPackage("com.acme.notes", "com.mentra.notes")).toBe(false)
  })
})
