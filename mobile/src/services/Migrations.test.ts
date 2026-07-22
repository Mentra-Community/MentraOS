import {result as Res} from "typesafe-ts"

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
  },
}))

const mockLoad = jest.mocked(storage.load)
const mockSave = jest.mocked(storage.save)
const mockSet = jest.mocked(engine.settings.set)

describe("mobile migrations", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSave.mockReturnValue(Res.ok(undefined))
    mockSet.mockImplementation(() => Res.try_async(async () => undefined))
  })

  it("resets MentraOS onboarding once for users upgrading from version 3", async () => {
    mockLoad.mockReturnValue(Res.ok(3))

    await migrate()

    expect(mockSet).toHaveBeenCalledWith(SETTINGS.onboarding_os_completed.key, false, false)
    expect(mockSave).toHaveBeenCalledWith("migration_version", 4)
  })

  it("does not reset MentraOS onboarding after the migration has run", async () => {
    mockLoad.mockReturnValue(Res.ok(4))

    await migrate()

    expect(mockSet).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })
})
