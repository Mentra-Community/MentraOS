import {Platform} from "react-native"
import {SETTINGS, engine} from "@mentra/engine"
import {mentraCallPackageName, notifyPackageName} from "@/constants/miniapps"
import {shouldHideMiniapp} from "./miniappVisibility"
import {deploymentStore} from "@/services/deployment/store"
import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import type {WorkspaceDeployment} from "@/services/deployment/types"

describe("live iOS miniapp visibility policy", () => {
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })
  beforeEach(async () => {
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    jest.replaceProperty(Platform, "OS", "ios")
    await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
    await engine.settings.set(SETTINGS.show_notify_ios.key, false)
  })
  afterEach(() => jest.restoreAllMocks())

  it("uses the managed Call manifest on iOS, then restores consumer defaults on workspace exit", async () => {
    const consumer = createConsumerDeployment()
    const workspace: WorkspaceDeployment = {
      kind: "workspace",
      source: "manual",
      activatedAt: "2026-09-22T00:00:00Z",
      workspaceOrigin: "https://enterprise.example",
      manifestUrl: "https://enterprise.example/.well-known/mentra-deployment.json",
      manifest: {
        ...consumer.manifest,
        features: {...consumer.manifest.features, nativeMeetings: true},
        miniapps: {
          configuration: {},
          managed: [
            {
              packageName: mentraCallPackageName,
              version: "2.1.29",
              bundleUrl: "https://enterprise.example/miniapps/call.zip",
              sha256: "a".repeat(64),
            },
          ],
        },
      },
    }
    const active = jest.spyOn(deploymentStore, "getActive").mockReturnValue(workspace)
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(false)
    expect(shouldHideMiniapp(notifyPackageName)).toBe(true)
    expect(engine.settings.get(SETTINGS.show_mentra_call_ios.key)).toBe(false)
    workspace.manifest.features.nativeMeetings = false
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(true)
    workspace.manifest.features.nativeMeetings = true
    workspace.manifest.miniapps.managed = []
    await engine.settings.set(SETTINGS.show_mentra_call_ios.key, true)
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(true)
    await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
    active.mockReturnValue(consumer)
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(true)
  })

  it.each([
    [mentraCallPackageName, SETTINGS.show_mentra_call_ios.key, notifyPackageName],
    [notifyPackageName, SETTINGS.show_notify_ios.key, mentraCallPackageName],
  ])("reads the current local setting for %s without enabling the other miniapp", async (pkg, key, other) => {
    expect(shouldHideMiniapp(pkg)).toBe(true)
    await engine.settings.set(key, true)
    expect(shouldHideMiniapp(pkg)).toBe(false)
    expect(shouldHideMiniapp(other)).toBe(true)
    await engine.settings.set(key, false)
    expect(shouldHideMiniapp(pkg)).toBe(true)
  })

  it.each([SETTINGS.show_mentra_call_ios.key, SETTINGS.show_notify_ios.key])(
    "keeps %s local, persistent, and off by default",
    (key) => {
      const descriptor = engine.settings.descriptor(key)
      expect(descriptor).toMatchObject({saveOnServer: false, persist: true})
      expect(descriptor.defaultValue()).toBe(false)
    },
  )
  it("applies the build override only to Call without changing either saved setting", async () => {
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(false)
    expect(shouldHideMiniapp(notifyPackageName)).toBe(true)
    expect(engine.settings.get(SETTINGS.show_mentra_call_ios.key)).toBe(false)
    expect(engine.settings.get(SETTINGS.show_notify_ios.key)).toBe(false)
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(true)
  })
})
