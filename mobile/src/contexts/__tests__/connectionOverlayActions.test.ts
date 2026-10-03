import {readReturnToMiniapp, stopTryingToReconnect} from "../connectionOverlayActions"

describe("stopTryingToReconnect", () => {
  it("returns to the requesting miniapp when the Wi-Fi flow was opened on its behalf", async () => {
    const order: string[] = []
    const clearHistoryAndGoHome = jest.fn((params?: {transition?: "fade"}) => {
      order.push(`home:${params?.transition ?? "default"}`)
    })
    const setForeground = jest.fn(async (pkg: string) => {
      order.push(`foreground:${pkg}`)
    })

    await stopTryingToReconnect({returnToMiniapp: "com.mentra.call", clearHistoryAndGoHome, setForeground})

    expect(order).toEqual(["home:fade", "foreground:com.mentra.call"])
  })

  it("just goes home when no miniapp is waiting", async () => {
    const clearHistoryAndGoHome = jest.fn()
    const setForeground = jest.fn(async () => {})

    await stopTryingToReconnect({returnToMiniapp: undefined, clearHistoryAndGoHome, setForeground})

    expect(clearHistoryAndGoHome).toHaveBeenCalledWith()
    expect(setForeground).not.toHaveBeenCalled()
  })
})

describe("readReturnToMiniapp", () => {
  it("accepts a string param", () => expect(readReturnToMiniapp("com.a")).toBe("com.a"))
  it("accepts the first entry of an array param", () => expect(readReturnToMiniapp(["com.a", "com.b"])).toBe("com.a"))
  it("rejects empty and non-string values", () => {
    expect(readReturnToMiniapp("")).toBeUndefined()
    expect(readReturnToMiniapp([])).toBeUndefined()
    expect(readReturnToMiniapp(undefined)).toBeUndefined()
    expect(readReturnToMiniapp(42)).toBeUndefined()
  })
})
