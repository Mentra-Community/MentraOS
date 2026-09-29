import {engine, type ClientApp} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"

import {openMiniappFromHome} from "./openMiniappFromHome"

jest.mock("@/contexts/ModalContext", () => ({showAlert: jest.fn(async () => {})}))
jest.mock("@/components/miniapp/offlineHostedPackages", () => ({isOfflineHosted: () => false}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({push: jest.fn()})}}))

const app = {packageName: "com.test.notes", name: "Notes", local: true, running: false} as ClientApp

beforeEach(() => {
  jest.clearAllMocks()
  ;(engine.miniapps.list as jest.Mock).mockReturnValue([app])
  ;(engine.miniapps.start as jest.Mock).mockResolvedValue(true)
})

it("does not foreground a splash while launch acceptance is pending", async () => {
  let finish!: (accepted: boolean) => void
  ;(engine.miniapps.start as jest.Mock).mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      }),
  )
  const launch = openMiniappFromHome(app)
  expect(engine.miniapps.setForeground).not.toHaveBeenCalled()
  finish(true)
  expect(await launch).toBe(true)
  expect(engine.miniapps.setForeground).toHaveBeenCalledWith(app.packageName)
})

it("stays on Home when an update begins during an accepted launch", async () => {
  let finish!: (accepted: boolean) => void
  ;(engine.miniapps.start as jest.Mock).mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      }),
  )
  const launch = openMiniappFromHome(app)
  ;(engine.miniapps.list as jest.Mock).mockReturnValue([{...app, updating: true}])
  finish(true)
  expect(await launch).toBe(false)
  expect(engine.miniapps.setForeground).not.toHaveBeenCalled()
  expect(showAlert).toHaveBeenCalledTimes(1)
  ;(engine.miniapps.list as jest.Mock).mockReturnValue([app])
  await Promise.resolve()
  expect(engine.miniapps.setForeground).not.toHaveBeenCalled()
})

it("never starts or foregrounds an updating miniapp", async () => {
  ;(engine.miniapps.list as jest.Mock).mockReturnValue([{...app, updating: true}])
  expect(await openMiniappFromHome(app)).toBe(false)
  expect(engine.miniapps.start).not.toHaveBeenCalled()
  expect(engine.miniapps.setForeground).not.toHaveBeenCalled()
})

it("keeps a rejected launch off screen, including stale running props", async () => {
  ;(engine.miniapps.start as jest.Mock).mockResolvedValue(false)
  expect(await openMiniappFromHome({...app, running: true})).toBe(false)
  expect(engine.miniapps.start).toHaveBeenCalledTimes(1)
  expect(engine.miniapps.setForeground).not.toHaveBeenCalled()
})
