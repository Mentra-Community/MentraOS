import {checkPermissionAfterSettingsReturn} from "./notificationPermissionFlow"

describe("checkPermissionAfterSettingsReturn", () => {
  it("checks only after the app backgrounds and becomes active again", async () => {
    let listener: ((state: string) => void) | undefined
    const remove = jest.fn()
    const check = jest.fn().mockResolvedValue(true)
    const result = checkPermissionAfterSettingsReturn(jest.fn().mockResolvedValue(undefined), check, (nextListener) => {
      listener = nextListener
      return {remove}
    })

    listener?.("active")
    expect(check).not.toHaveBeenCalled()
    listener?.("background")
    listener?.("active")

    await expect(result).resolves.toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it("reports denial after the user returns from Settings", async () => {
    let listener: ((state: string) => void) | undefined
    const remove = jest.fn()
    const result = checkPermissionAfterSettingsReturn(
      jest.fn().mockResolvedValue(undefined),
      jest.fn().mockResolvedValue(false),
      (nextListener) => {
        listener = nextListener
        return {remove}
      },
    )

    listener?.("background")
    listener?.("active")

    await expect(result).resolves.toBe(false)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it("cleans up and rejects if Settings cannot open", async () => {
    const remove = jest.fn()
    const result = checkPermissionAfterSettingsReturn(
      jest.fn().mockRejectedValue(new Error("open failed")),
      jest.fn(),
      () => ({remove}),
    )

    await expect(result).rejects.toThrow("open failed")
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
