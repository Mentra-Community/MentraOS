import {afterEach, describe, expect, test} from "bun:test"

import {
  assertMiniappDevelopmentAllowed,
  configure,
  getConfigValues,
  getMiniappConfiguration,
  isDevMiniappAllowed,
  isFeatureEnabled,
  isInstalledMiniappAllowed,
  isLocalMiniappPackageAllowed,
  isMiniappAvailable,
  isMiniappDevelopmentAllowed,
  isOfflineSystemMiniappAllowed,
  resetForTests,
  start,
  updateMiniappPolicy,
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

  test.each([
    [["com.mentra.settings"], false],
    [["com.mentra.settings", "com.mentra.miniappdev"], true],
    [null, true],
  ])("admits developer builds of any package only where the developer tools are approved (%j)", (approved, allowed) => {
    configure({
      auth: {},
      config: {
        bundledSystemMiniappPackages: ["com.mentra.captions"],
        localMiniappPolicy: {
          systemPackageNames: approved,
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

    expect(isMiniappDevelopmentAllowed()).toBe(allowed)
    expect(isDevMiniappAllowed("com.example.call")).toBe(allowed)
    expect(isDevMiniappAllowed("com.example.other")).toBe(allowed)
    expect(isInstalledMiniappAllowed("com.example.other", "1.0.0", {source: "direct_download"})).toBe(allowed)
    // An install from a miniapp URL is an explicit install too.
    const fromUrl = {source: "url", sourceUrl: "https://tools.example.com/app/"}
    expect(isInstalledMiniappAllowed("com.example.tools", "1.0.0", fromUrl)).toBe(allowed)
    // A package the build bundles keeps the system policy, whatever URL it came from.
    const captionsUrl = {source: "url", sourceUrl: "https://miniapps.mentraglass.com/com.mentra.captions/"}
    expect(isInstalledMiniappAllowed("com.mentra.captions", "1.0.0", captionsUrl)).toBe(approved === null)
    if (allowed) expect(() => assertMiniappDevelopmentAllowed()).not.toThrow()
    else expect(() => assertMiniappDevelopmentAllowed()).toThrow("does not allow miniapp development")
  })

  test("runs a Fleet assignment's release from its URL where development is off", () => {
    configure({
      auth: {},
      config: {
        bundledSystemMiniappPackages: ["com.mentra.captions"],
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
    expect(isMiniappDevelopmentAllowed()).toBe(false)
    const fromUrl = {source: "url", sourceUrl: "https://tools.example.com/app/"}
    // The workspace's own assignment is not development.
    expect(isInstalledMiniappAllowed("com.example.tools", "1.0.0", fromUrl, {assigned: true})).toBe(true)
    // Without it, an install from a URL is an explicit install, which this deployment leaves out.
    expect(isInstalledMiniappAllowed("com.example.tools", "1.0.0", fromUrl, {assigned: false})).toBe(false)
    expect(isInstalledMiniappAllowed("com.example.tools", "1.0.0", fromUrl)).toBe(false)
    // An assignment rewrites no deployment trust: a bundled package it left out stays out, and a package its
    // manifest pins stays the manifest's.
    const captionsUrl = {source: "url", sourceUrl: "https://miniapps.mentraglass.com/com.mentra.captions/"}
    expect(isInstalledMiniappAllowed("com.mentra.captions", "1.0.0", captionsUrl, {assigned: true})).toBe(false)
    const callUrl = {source: "url", sourceUrl: "https://call.example.com/"}
    expect(isInstalledMiniappAllowed("com.example.call", "1.3.0", callUrl, {assigned: true})).toBe(false)
    // The package itself may run: launches check that first.
    expect(isLocalMiniappPackageAllowed("com.example.tools", {assigned: true})).toBe(true)
    expect(isLocalMiniappPackageAllowed("com.example.tools", {assigned: false})).toBe(false)
    expect(isLocalMiniappPackageAllowed("com.example.tools")).toBe(false)
    expect(isLocalMiniappPackageAllowed("com.mentra.captions", {assigned: true})).toBe(false)
    // Only a release installed from its URL: a scanned release QR stays a developer build.
    expect(isInstalledMiniappAllowed("com.example.tools", "1.0.0", {source: "direct_download"}, {assigned: true})).toBe(
      false,
    )
  })

  test("allows consumer developer builds", () => {
    configure({auth: {}})
    expect(isMiniappDevelopmentAllowed()).toBe(true)
    expect(isDevMiniappAllowed("com.example.call")).toBe(true)
    expect(
      isInstalledMiniappAllowed("com.example.tools", "1.0.0", {source: "url", sourceUrl: "https://tools.example.com/"}),
    ).toBe(true)
  })

  test("applies a live Super Mode gate to listing, cached releases and direct/dev launches", () => {
    let allowed = false
    const packageName = "com.mentra.link"
    configure({auth: {}, config: {isLocalMiniappAllowed: (pkg) => pkg !== packageName || allowed}})
    const check = () => [
      isLocalMiniappPackageAllowed(packageName),
      isOfflineSystemMiniappAllowed(packageName),
      isInstalledMiniappAllowed(packageName, "1.0.18", {source: "bundled_asset"}),
      isDevMiniappAllowed(packageName),
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
    expect(isDevMiniappAllowed(packageName)).toBe(false)
    allowed = true
    expect(isInstalledMiniappAllowed(packageName, "1.0.18", identity)).toBe(true)
    expect(isInstalledMiniappAllowed(packageName, "1.0.17", identity)).toBe(false)
    expect(isDevMiniappAllowed(packageName)).toBe(true)
  })
})

describe("bundled releases the retired Store updated", () => {
  afterEach(resetForTests)
  const identity = {source: "system_store", storePackageName: "com.mentra.store"}
  function configureOrganization(approved: string[] | null, managed = false) {
    configure({
      auth: {},
      config: {
        bundledSystemMiniappPackages: ["com.mentra.notes"],
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

  test.each([null, ["com.mentra.notes"]])("stay visible where the bundled release is approved (%j)", (approved) => {
    configureOrganization(approved)
    expect(isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", identity)).toBe(true)
    expect(
      isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", {...identity, storePackageName: "com.other.store"}),
    ).toBe(false)
  })

  test("do not bypass an excluded package or an organization pin", () => {
    configureOrganization([])
    expect(isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", identity)).toBe(false)
    configureOrganization(null, true)
    expect(isInstalledMiniappAllowed("com.mentra.notes", "2.0.0", identity)).toBe(false)
  })

  test("the host's availability gate separates launches from background maintenance", () => {
    expect(isMiniappAvailable("com.mentra.store")).toBe(true)
    configure({
      auth: {},
      config: {isMiniappAvailable: (packageName, mode) => mode === "background" || packageName !== "com.mentra.store"},
    })
    expect(isMiniappAvailable("com.mentra.store")).toBe(false)
    expect(isMiniappAvailable("com.mentra.store", "background")).toBe(true)
    expect(isMiniappAvailable("com.mentra.notes")).toBe(true)
  })
})

describe("updateMiniappPolicy", () => {
  afterEach(() => resetForTests())

  const acme = (packageName: string, sha256: string) => ({
    packageName,
    version: "1.0.0",
    sha256,
    deploymentId: "acme",
    deploymentOrigin: "https://acme.example",
  })
  const managedInstall = (packageName: string, bundleSha256: string) =>
    isInstalledMiniappAllowed(packageName, "1.0.0", {
      source: "deployment_manifest",
      bundleSha256,
      deploymentId: "acme",
      deploymentOrigin: "https://acme.example",
    })

  test("admits a newly managed miniapp on a running runtime and keeps the session's other settings", async () => {
    configure({
      auth: {},
      config: {
        coreUrl: "https://core.acme.example",
        localMiniappPolicy: {systemPackageNames: ["com.mentra.settings"], managed: [acme("com.mentra.call", "aa")]},
        features: {cloudSpeech: true, navigation: false},
      },
    })
    await start()
    expect(managedInstall("com.mentra.enterprise", "bb")).toBe(false)

    updateMiniappPolicy({
      localMiniappPolicy: {
        systemPackageNames: ["com.mentra.settings"],
        managed: [acme("com.mentra.call", "aa"), acme("com.mentra.enterprise", "BB")],
      },
      miniappConfiguration: {"com.mentra.enterprise": {backendUrl: "https://backend.acme.example"}},
    })

    expect(managedInstall("com.mentra.enterprise", "bb")).toBe(true)
    expect(managedInstall("com.mentra.call", "aa")).toBe(true)
    expect(getMiniappConfiguration("com.mentra.enterprise")).toEqual({backendUrl: "https://backend.acme.example"})
    // Endpoints and feature switches belong to the started session.
    expect(getConfigValues().coreUrl).toBe("https://core.acme.example")
    expect(isFeatureEnabled("cloudSpeech")).toBe(true)
    expect(isFeatureEnabled("navigation")).toBe(false)
  })

  test("is ignored before configure()", () => {
    updateMiniappPolicy({localMiniappAllowlist: ["com.mentra.settings"]})
    expect(getConfigValues().localMiniappAllowlist).toBeUndefined()
  })
})
