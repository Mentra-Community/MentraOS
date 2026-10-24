import {engine, type MiniappInstallPreview} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"
import en from "@/i18n/en"

import {
  confirmLocalMiniappInstall,
  installLocalMiniapp,
  localMiniappAddress,
  localMiniappInstallErrorAlert,
} from "./localMiniappInstall"

jest.mock("@/contexts/ModalContext", () => ({NO_ANSWER: -1, showAlert: jest.fn(), waitForAlertHost: async () => {}}))
jest.mock("expo-image", () => ({Image: () => null}))

const url = "http://192.168.1.20:8080/"
const preview: MiniappInstallPreview = {
  url,
  host: "192.168.1.20",
  local: true,
  packageName: "com.mentra.notes",
  name: "Notes",
  iconUrl: null,
  ageRating: null,
  private: false,
  alreadyInstalled: false,
}

/** The engine's install error, as the engine throws it. */
function installError(code: string): Error {
  return Object.assign(new Error(`install failed: ${code}`), {name: "InstallMiniappError", code})
}

beforeEach(() => {
  jest.mocked(showAlert).mockReset()
  jest.mocked(engine.miniapps.install).mockReset()
})

describe("the install sheet for a local-network build", () => {
  it("says it comes from the local network, with its address, and installs only on Install", async () => {
    jest.mocked(showAlert).mockResolvedValueOnce(1)
    expect(await confirmLocalMiniappInstall(preview)).toBe(true)
    expect(showAlert).toHaveBeenCalledWith({
      title: "Notes",
      message: translate("miniappInstall:fromLocalNetwork", {address: "192.168.1.20:8080"}),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("miniappInstall:install")}],
      // The one install sheet: the miniapp's icon, and a swipe means Cancel.
      options: expect.objectContaining({allowDismiss: true, icon: expect.anything()}),
    })
    expect(en.miniappInstall.fromLocalNetwork).toBe("From your local network\n{{address}}")
  })

  it.each([
    ["Cancel", 0],
    ["dismissing it", -1],
  ])("declines on %s", async (_name, answer) => {
    jest.mocked(showAlert).mockResolvedValueOnce(answer)
    expect(await confirmLocalMiniappInstall(preview)).toBe(false)
  })

  it("shows the age rating beside the name", async () => {
    jest.mocked(showAlert).mockResolvedValueOnce(1)
    await confirmLocalMiniappInstall({...preview, ageRating: "13+"})
    expect(jest.mocked(showAlert).mock.calls[0]![0].title).toBe(
      translate("miniappInstall:nameWithRating", {name: "Notes", rating: "13+"}),
    )
    expect(en.miniappInstall.nameWithRating).toBe("{{name}} · {{rating}}")
  })

  it("names the address by host and port", () => {
    expect(localMiniappAddress("http://laptop.local:8080/app/")).toBe("laptop.local:8080")
    expect(localMiniappAddress("http://[fd00::1]:8080/")).toBe("[fd00::1]:8080")
  })
})

describe("installing a local-network build", () => {
  it("installs through the engine as a local build, asking with the sheet", async () => {
    jest.mocked(showAlert).mockResolvedValueOnce(1)
    jest.mocked(engine.miniapps.install).mockImplementationOnce(async (_url, options) => {
      expect(await options.confirm!(preview)).toBe(true)
      return {status: "installed", packageName: "com.mentra.notes", version: "1.2.0"}
    })
    expect(await installLocalMiniapp(url)).toEqual({packageName: "com.mentra.notes", name: "Notes", version: "1.2.0"})
    expect(jest.mocked(engine.miniapps.install).mock.calls[0]![0]).toBe(url)
    expect(jest.mocked(engine.miniapps.install).mock.calls[0]![1]).toMatchObject({source: "local"})
  })

  it("asks for what the build needs after Install and before anything installs, and cancels when it's refused", async () => {
    const order: string[] = []
    jest.mocked(showAlert).mockImplementation(async () => {
      order.push("sheet")
      return 1
    })
    jest.mocked(engine.miniapps.install).mockImplementation(async (_url, options) => {
      const accepted = await options.confirm!(preview)
      order.push(accepted ? "install" : "not installed")
      if (!accepted) throw installError("cancelled")
      return {status: "installed", packageName: "com.mentra.notes", version: "1.2.0"}
    })
    const beforeInstall = jest.fn(async (shown: MiniappInstallPreview) => {
      order.push(`permissions for ${shown.packageName}`)
      return false
    })
    expect(await installLocalMiniapp(url, {beforeInstall})).toBeNull()
    expect(order).toEqual(["sheet", "permissions for com.mentra.notes", "not installed"])

    order.length = 0
    beforeInstall.mockResolvedValueOnce(true)
    expect(await installLocalMiniapp(url, {beforeInstall})).not.toBeNull()
    expect(order).toEqual(["sheet", "install"])
  })

  it("fails with what went wrong when preparing the install fails, rather than as a cancellation", async () => {
    jest.mocked(showAlert).mockResolvedValueOnce(1)
    // Like the engine: a sheet that answers false is a cancellation.
    jest.mocked(engine.miniapps.install).mockImplementationOnce(async (_url, options) => {
      if (!(await options.confirm!(preview))) throw installError("cancelled")
      return {status: "installed", packageName: "com.mentra.notes", version: "1.2.0"}
    })
    const unreachable = new Error("Failed to fetch miniapp.json: 503")
    await expect(
      installLocalMiniapp(url, {
        beforeInstall: async () => {
          throw unreachable
        },
      }),
    ).rejects.toBe(unreachable)
  })

  it("never asks for permissions when the sheet is declined", async () => {
    jest.mocked(showAlert).mockResolvedValueOnce(0)
    jest.mocked(engine.miniapps.install).mockImplementationOnce(async (_url, options) => {
      if (!(await options.confirm!(preview))) throw installError("cancelled")
      return {status: "installed", packageName: "com.mentra.notes", version: "1.2.0"}
    })
    const beforeInstall = jest.fn(async () => true)
    expect(await installLocalMiniapp(url, {beforeInstall})).toBeNull()
    expect(beforeInstall).not.toHaveBeenCalled()
  })

  it("answers null when the person cancelled", async () => {
    jest.mocked(engine.miniapps.install).mockRejectedValueOnce(installError("cancelled"))
    expect(await installLocalMiniapp(url)).toBeNull()
  })

  it("passes every other failure on", async () => {
    const refused = installError("not_a_miniapp")
    jest.mocked(engine.miniapps.install).mockRejectedValueOnce(refused)
    await expect(installLocalMiniapp(url)).rejects.toBe(refused)
  })
})

describe("a failed local-network install's alert", () => {
  it.each([
    ["not_a_miniapp", translate("debugSettings:miniappLocalInstallNotAMiniapp", {address: "192.168.1.20:8080"})],
    ["network", translate("debugSettings:miniappLocalInstallNetwork", {address: "192.168.1.20:8080"})],
    ["access_denied", translate("debugSettings:miniappLocalInstallAccessDenied")],
    ["needs_newer_app", translate("debugSettings:miniappLocalInstallNeedsNewerApp")],
    ["integrity", translate("debugSettings:miniappLocalInstallIntegrity")],
    ["signature_invalid", translate("debugSettings:miniappLocalInstallSignature")],
  ])("explains %s", (code, message) => {
    expect(localMiniappInstallErrorAlert(installError(code), url)).toEqual({
      title: translate("debugSettings:miniappLocalInstallFailedTitle"),
      message,
    })
  })

  it("shows any other failure's own message", () => {
    expect(localMiniappInstallErrorAlert(new Error("disk full"), url).message).toBe("disk full")
  })
})
