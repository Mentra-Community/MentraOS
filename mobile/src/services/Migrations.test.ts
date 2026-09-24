import {result as Res} from "typesafe-ts"
import {Platform} from "react-native"

import {storage} from "@/utils/storage"
import {SETTINGS, engine} from "@mentra/engine"

import {migrate} from "./Migrations"

jest.mock("@/utils/storage", () => ({
  storage: {
    load: jest.fn(),
    remove: jest.fn(),
    save: jest.fn(),
  },
}))

jest.mock("@mentra/engine", () => ({
  SETTINGS: {
    dashboard_depth: {key: "dashboard_depth"},
    onboarding_os_completed: {key: "onboarding_os_completed"},
  },
  engine: {
    settings: {
      set: jest.fn(),
    },
    miniapps: {
      setHiddenStatus: jest.fn(),
    },
  },
}))

const mockLoad = jest.mocked(storage.load)
const mockSave = jest.mocked(storage.save)
const mockSet = jest.mocked(engine.settings.set)
const mockSetHidden = jest.mocked(engine.miniapps.setHiddenStatus)

describe("mobile migrations", () => {
  afterEach(() => jest.restoreAllMocks())

  beforeEach(() => {
    jest.clearAllMocks()
    mockSave.mockReturnValue(Res.ok(undefined))
    // The workspace resolves the app and engine copies of typesafe-ts as
    // separate nominal classes; bridge that test-only package boundary.
    mockSet.mockImplementation(
      () => Res.try_async(async () => undefined) as unknown as ReturnType<typeof engine.settings.set>,
    )
  })

  it("resets MentraOS onboarding once for users upgrading from version 3", async () => {
    mockLoad.mockReturnValue(Res.ok(3))

    await migrate()

    expect(mockSet).toHaveBeenCalledWith(SETTINGS.onboarding_os_completed.key, false, false)
    expect(mockSave).toHaveBeenCalledWith("migration_version", 4)
  })

  it("does not reset MentraOS onboarding after the migration has run", async () => {
    mockLoad.mockReturnValue(Res.ok(5))

    await migrate()

    expect(mockSet).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("reserves migration 5 without unhiding Call before the current policy is applied", async () => {
    jest.replaceProperty(Platform, "OS", "ios")
    mockLoad.mockImplementation((key) => Res.ok(key === "migration_version" ? 4 : true))

    await migrate()

    expect(mockSetHidden).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockSave).toHaveBeenCalledWith("migration_version", 5)
  })

  it("preserves Android hiding and an iOS user's choice after migration", async () => {
    jest.replaceProperty(Platform, "OS", "android")
    mockLoad.mockReturnValue(Res.ok(4))
    await migrate()
    expect(mockSetHidden).not.toHaveBeenCalled()

    jest.replaceProperty(Platform, "OS", "ios")
    mockLoad.mockReturnValue(Res.ok(5))
    await migrate()
    expect(mockSetHidden).not.toHaveBeenCalled()
  })
})
