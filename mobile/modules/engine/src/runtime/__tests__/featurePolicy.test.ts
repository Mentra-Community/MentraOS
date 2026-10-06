import {afterEach, describe, expect, test} from "bun:test"

import {
  configure,
  isDevMiniappAllowed,
  isFeatureEnabled,
  isInstalledMiniappAllowed,
  isLocalMiniappPackageAllowed,
  isOfflineSystemMiniappAllowed,
  resetForTests,
} from "../bootstrap"

describe("deployment feature policy", () => {
  afterEach(() => resetForTests())

  test("preserves consumer behavior when no policy is supplied", () => {
    configure({auth: {}})
    expect(isFeatureEnabled("managedStreams")).toBe(true)
    expect(isFeatureEnabled("navigation")).toBe(true)
  })

  test("fails closed for explicitly disabled workspace capabilities", () => {
    configure({
      auth: {},
      config: {
        features: {
          managedStreams: false,
          cloudSpeech: false,
          onDeviceSpeech: false,
          navigation: false,
        },
      },
    })

    expect(isFeatureEnabled("managedStreams")).toBe(false)
    expect(isFeatureEnabled("cloudSpeech")).toBe(false)
    expect(isFeatureEnabled("onDeviceSpeech")).toBe(false)
    expect(isFeatureEnabled("navigation")).toBe(false)
    expect(isFeatureEnabled("nativeMeetings")).toBe(true)
  })

  test("binds managed miniapp authorization to exact deployment provenance", () => {
    const mutablePolicy = {
      systemPackageNames: ["com.mentra.settings"],
      managed: [
        {
          packageName: "com.example.call",
          version: "1.2.0",
          sha256: "abc",
          deploymentId: "acme",
          deploymentOrigin: "https://acme.example",
        },
      ],
    }
    configure({auth: {}, config: {localMiniappPolicy: mutablePolicy}})
    mutablePolicy.managed[0].sha256 = "changed-after-configure"

    expect(isOfflineSystemMiniappAllowed("com.mentra.settings")).toBe(true)
    expect(isInstalledMiniappAllowed("com.mentra.settings", "1.0.0", {source: "direct_download"})).toBe(false)
    expect(
      isInstalledMiniappAllowed("com.example.call", "1.2.0", {
        source: "deployment_manifest",
        bundleSha256: "abc",
        deploymentId: "acme",
        deploymentOrigin: "https://acme.example",
      }),
    ).toBe(true)
    expect(
      isInstalledMiniappAllowed("com.example.call", "1.2.0", {
        source: "deployment_manifest",
        bundleSha256: "wrong",
        deploymentId: "acme",
        deploymentOrigin: "https://acme.example",
      }),
    ).toBe(false)
  })

  test("admits a developer build only in super mode, and only for a managed package", () => {
    configure({
      auth: {},
      config: {
        localMiniappPolicy: {
          systemPackageNames: ["com.mentra.settings"],
          managed: [
            {
              packageName: "com.example.call",
              version: "1.2.0",
              sha256: "abc",
              deploymentId: "acme",
              deploymentOrigin: "https://acme.example",
            },
          ],
        },
      },
    })

    expect(isDevMiniappAllowed("com.example.call", true)).toBe(true)
    expect(isDevMiniappAllowed("com.example.call", false)).toBe(false)
    expect(isDevMiniappAllowed("com.example.other", true)).toBe(false)
    expect(isDevMiniappAllowed("com.mentra.settings", true)).toBe(false)
  })

  test("keeps consumer developer builds independent of super mode", () => {
    configure({auth: {}})
    expect(isDevMiniappAllowed("com.example.call", false)).toBe(true)
  })

  test("applies a live Super Mode gate to listing, cached releases and direct/dev launches", () => {
    let allowed = false
    const packageName = "com.mentra.link"
    configure({auth: {}, config: {isLocalMiniappAllowed: (pkg) => pkg !== packageName || allowed}})
    const check = () => [
      isLocalMiniappPackageAllowed(packageName),
      isOfflineSystemMiniappAllowed(packageName),
      isInstalledMiniappAllowed(packageName, "1.0.18", {source: "bundled_asset"}),
      isDevMiniappAllowed(packageName, true),
    ]
    expect(check()).toEqual([false, false, false, false])
    expect(isLocalMiniappPackageAllowed("com.mentra.notes")).toBe(true)
    allowed = true
    expect(check()).toEqual([true, true, true, true])
    allowed = false
    expect(check()).toEqual([false, false, false, false])
  })

  test("composes Super Mode restrictions with managed workspace policy", () => {
    let allowed = false
    const packageName = "com.mentra.link"
    const identity = {
      source: "deployment_manifest",
      bundleSha256: "abc",
      deploymentId: "acme",
      deploymentOrigin: "https://acme.example",
    }
    configure({
      auth: {},
      config: {
        isLocalMiniappAllowed: (pkg) => pkg !== packageName || allowed,
        localMiniappPolicy: {
          systemPackageNames: null,
          managed: [
            {
              packageName,
              version: "1.0.18",
              sha256: "abc",
              deploymentId: "acme",
              deploymentOrigin: "https://acme.example",
            },
          ],
        },
      },
    })
    expect(isInstalledMiniappAllowed(packageName, "1.0.18", identity)).toBe(false)
    expect(isOfflineSystemMiniappAllowed(packageName)).toBe(false)
    expect(isDevMiniappAllowed(packageName, true)).toBe(false)
    allowed = true
    expect(isInstalledMiniappAllowed(packageName, "1.0.18", identity)).toBe(true)
    expect(isInstalledMiniappAllowed(packageName, "1.0.17", identity)).toBe(false)
    expect(isDevMiniappAllowed(packageName, false)).toBe(false)
    expect(isDevMiniappAllowed(packageName, true)).toBe(true)
  })
})
