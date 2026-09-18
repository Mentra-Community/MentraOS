import {engine, type ClientApp} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

import {uninstallAppUI} from "./uninstallAppUI"

jest.mock("@/contexts/ModalContext", () => ({showAlert: jest.fn()}))

const app = {packageName: "com.test.notes", name: "Notes", running: false} as ClientApp

beforeEach(() => {
  jest.clearAllMocks()
  ;(showAlert as jest.Mock).mockResolvedValue(0)
  ;(engine.miniapps.list as jest.Mock).mockReturnValue([app])
})

it("shows the updating popup without confirming or uninstalling", async () => {
  ;(engine.miniapps.list as jest.Mock).mockReturnValue([{...app, updating: true}])
  await uninstallAppUI(app)
  expect(showAlert).toHaveBeenCalledTimes(1)
  expect(showAlert).toHaveBeenCalledWith(
    expect.objectContaining({
      title: translate("home:miniappUpdatingTitle"),
    }),
  )
  expect(engine.miniapps.uninstall).not.toHaveBeenCalled()
  expect(engine.miniapps.stop).not.toHaveBeenCalled()
})

it("rechecks an update that starts while uninstall confirmation is open", async () => {
  let confirm!: (value: number) => void
  ;(showAlert as jest.Mock).mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        confirm = resolve
      }),
  )
  const attempt = uninstallAppUI(app)
  ;(engine.miniapps.list as jest.Mock).mockReturnValue([{...app, updating: true}])
  confirm(1)
  await attempt
  expect(showAlert).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: translate("home:miniappUpdatingTitle"),
    }),
  )
  expect(engine.miniapps.uninstall).not.toHaveBeenCalled()
})
