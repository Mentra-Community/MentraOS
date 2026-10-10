import {nativeHttpRequest, type NativeHttpResult, type NativeHttpTransport} from "./nativeHttpRequest"

const response: NativeHttpResult = {status: 200, statusText: "OK", headers: {}, body: "{}"}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return {promise, resolve, reject}
}

function transport(request = deferred<NativeHttpResult>()) {
  const native: NativeHttpTransport = {
    nativeHttpRequest: jest.fn(() => request.promise),
    cancelNativeHttpRequest: jest.fn(async () => {}),
  }
  return {native, request}
}

describe("nativeHttpRequest", () => {
  test("pre-aborted requests do not start or cancel native work", async () => {
    const {native} = transport()
    const controller = new AbortController()
    const reason = new Error("deadline")
    controller.abort(reason)
    await expect(nativeHttpRequest(native, "GET", "https://example.com", {}, null, controller.signal)).rejects.toBe(reason)
    expect(native.nativeHttpRequest).not.toHaveBeenCalled()
    expect(native.cancelNativeHttpRequest).not.toHaveBeenCalled()
  })

  test("abort cancels only this request and waits for native cancellation acceptance", async () => {
    const {native, request} = transport()
    const cancellation = deferred<void>()
    native.cancelNativeHttpRequest = jest.fn(() => cancellation.promise)
    const controller = new AbortController()
    const remove = jest.spyOn(controller.signal, "removeEventListener")
    const promise = nativeHttpRequest(native, "POST", "https://example.com", {test: "header"}, "body", controller.signal)
    const rejected = expect(promise).rejects.toMatchObject({name: "AbortError"})
    controller.abort()
    const id = (native.nativeHttpRequest as jest.Mock).mock.calls[0][0]
    expect(native.cancelNativeHttpRequest).toHaveBeenCalledWith(id)
    expect(remove).not.toHaveBeenCalled()
    request.reject(new Error("cancelled socket"))
    cancellation.resolve()
    await rejected
    expect(native.cancelNativeHttpRequest).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  test("an abort during native start is cancelled after start and removes its listener", async () => {
    const {native} = transport()
    const controller = new AbortController()
    const order: string[] = []
    native.nativeHttpRequest = jest.fn(() => {
      order.push("start")
      controller.abort()
      return new Promise<NativeHttpResult>(() => {})
    })
    native.cancelNativeHttpRequest = jest.fn(async () => {order.push("cancel")})
    await expect(nativeHttpRequest(native, "GET", "https://example.com", {}, null, controller.signal)).rejects.toMatchObject({name: "AbortError"})
    expect(order).toEqual(["start", "cancel"])
  })

  test.each(["success", "failure"])("%s removes its abort listener and a later abort does not cancel", async (outcome) => {
    const {native, request} = transport()
    const controller = new AbortController()
    const remove = jest.spyOn(controller.signal, "removeEventListener")
    const promise = nativeHttpRequest(native, "GET", "https://example.com", {}, null, controller.signal)
    if (outcome === "success") {
      request.resolve(response)
      await expect(promise).resolves.toBe(response)
    } else {
      request.reject(new Error("offline"))
      await expect(promise).rejects.toThrow("offline")
    }
    controller.abort()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(native.cancelNativeHttpRequest).not.toHaveBeenCalled()
  })

  test("independent calls have separate IDs and unsignalled calls keep the native path", async () => {
    const {native, request} = transport()
    const first = nativeHttpRequest(native, "GET", "https://example.com/first", {}, null)
    const second = nativeHttpRequest(native, "GET", "https://example.com/second", {}, null)
    const calls = (native.nativeHttpRequest as jest.Mock).mock.calls
    expect(calls[0][0]).not.toBe(calls[1][0])
    request.resolve(response)
    await Promise.all([first, second])
    expect(native.cancelNativeHttpRequest).not.toHaveBeenCalled()
  })
})
