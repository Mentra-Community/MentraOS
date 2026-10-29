import {SETTINGS, engine} from "@mentra/engine"
import {linkLingoPackageName} from "@/constants/miniapps"
import {isSuperModeMiniappAllowed, shouldHideMiniapp, shouldSkipMiniappInstall} from "./miniappVisibility"

afterEach(async () => {
  await engine.settings.set(SETTINGS.super_mode.key, false)
})

it("requires Super Mode for bundled, cached and developer LinkLingo", async () => {
  await engine.settings.set(SETTINGS.super_mode.key, false)
  expect(isSuperModeMiniappAllowed(linkLingoPackageName)).toBe(false)
  expect(shouldSkipMiniappInstall(linkLingoPackageName)).toBe(true)
  expect(shouldHideMiniapp(linkLingoPackageName, "1.0.18")).toBe(true)
  expect(shouldHideMiniapp(linkLingoPackageName, "dev-3120", {dev: true})).toBe(true)
  expect(isSuperModeMiniappAllowed("com.mentra.notes")).toBe(true)

  await engine.settings.set(SETTINGS.super_mode.key, true)
  expect(isSuperModeMiniappAllowed(linkLingoPackageName)).toBe(true)
  expect(shouldSkipMiniappInstall(linkLingoPackageName)).toBe(false)
  expect(shouldHideMiniapp(linkLingoPackageName, "1.0.18")).toBe(false)
  expect(shouldHideMiniapp(linkLingoPackageName, "dev-3120", {dev: true})).toBe(false)

  await engine.settings.set(SETTINGS.super_mode.key, false)
  expect(shouldHideMiniapp(linkLingoPackageName, "1.0.18")).toBe(true)
  expect(isSuperModeMiniappAllowed(linkLingoPackageName)).toBe(false)
})
