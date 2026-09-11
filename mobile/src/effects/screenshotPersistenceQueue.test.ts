import {enqueueScreenshotPersistence} from "./screenshotPersistenceQueue"

describe("enqueueScreenshotPersistence", () => {
  test("does not start a later persistence task until the current one finishes", async () => {
    const events: string[] = []
    let finishFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      finishFirst = resolve
    })

    const first = enqueueScreenshotPersistence(async () => {
      events.push("first:start")
      await firstCanFinish
      events.push("first:end")
    })
    const second = enqueueScreenshotPersistence(async () => {
      events.push("second:start")
      events.push("second:end")
    })

    await Promise.resolve()
    expect(events).toEqual(["first:start"])

    finishFirst()
    await Promise.all([first, second])
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"])
  })

  test("continues processing after a persistence task fails", async () => {
    await expect(
      enqueueScreenshotPersistence(async () => {
        throw new Error("write failed")
      }),
    ).rejects.toThrow("write failed")

    await expect(enqueueScreenshotPersistence(async () => "saved")).resolves.toBe("saved")
  })
})
