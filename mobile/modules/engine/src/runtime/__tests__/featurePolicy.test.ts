import {afterEach, describe, expect, test} from "bun:test"

import {
  configure,
  isFeatureEnabled,
  isInstalledMiniappAllowed,
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

  test("a managed pin takes precedence over an unrestricted bundled-app allowlist", () => {
    configure({
      auth: {},
      config: {
        localMiniappPolicy: {
          systemPackageNames: null,
          managed: [
            {
              packageName: "com.mentra.call",
              version: "2.1.31",
              sha256: "abc",
              deploymentId: "acme",
              deploymentOrigin: "https://acme.example",
            },
          ],
        },
      },
    })
    expect(isInstalledMiniappAllowed("com.mentra.call", "2.1.31", {source: "bundled_asset"})).toBe(false)
    expect(isInstalledMiniappAllowed("com.mentra.notes", "1.0.0", {source: "bundled_asset"})).toBe(true)
  })
})

describe("workspace Store release visibility", () => {
  afterEach(resetForTests)
  const identity = {source: "system_store", storePackageName: "com.mentra.store"}
  function configureWorkspace(approved: string[] | null, managed: boolean = false) {
    configure({
      auth: {},
      config: {
        bundledSystemMiniappPackages: ["com.mentra.notes", "com.mentra.store"],
        bundledStoreMiniappPackages: ["com.mentra.store"],
        bundledSystemMiniappStoreOwners: {"com.mentra.notes": "com.mentra.store"},
        localMiniappPolicy: {
          systemPackageNames: approved,
          managed: managed
            ? [
                {
                  packageName: "com.mentra.notes",
                  version: "1.0.0",
                  sha256: "abc",
                  deploymentId: "acme",
                  deploymentOrigin: "https://acme.example",
                },
              ]
            : [],
        },
      },
    })
  }
  test.each([null, ["com.mentra.notes"]])("keeps an approved Store-updated release visible (%j)", (approved) => {
    configureWorkspace(approved)
    expect(isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", identity)).toBe(true)
    expect(
      isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", {...identity, storePackageName: "com.other.store"}),
    ).toBe(false)
    expect(isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", {source: "direct_download"})).toBe(false)
  })
  test("does not bypass an excluded package or workspace pin", () => {
    configureWorkspace([])
    expect(isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", identity)).toBe(false)
    configureWorkspace(null, true)
    expect(isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", identity)).toBe(false)
  })
})
