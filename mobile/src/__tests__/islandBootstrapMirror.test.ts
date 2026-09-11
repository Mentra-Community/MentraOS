// Imports the real bootstrap + displayMirror by path (not via "@mentra/engine",
// which jest mocks) so the actual logic runs under the mobile jest CI runner.
import * as bootstrap from "../../modules/engine/src/runtime/bootstrap"
import {displayMirror} from "../../modules/engine/src/facades/displayMirror"
import {useDisplayStore, flushDisplayCoalesceForTests} from "../../modules/engine/src/stores/display"

describe("island bootstrap front door", () => {
  beforeEach(async () => {
    await bootstrap.stop()
  })

  it("start() before configure() rejects (this test runs first, nothing configured yet)", async () => {
    await expect(bootstrap.start()).rejects.toThrow(/configure/)
  })

  it("configure() stores auth/config/analytics for island to read", () => {
    const auth = {getSubjectToken: async () => ({token: "t", type: "supabase" as const})}
    const analytics = jest.fn()
    bootstrap.configure({auth, config: {coreUrl: "http://core", oemId: "mentra"}, analytics})
    expect(bootstrap.getAuth()).toBe(auth)
    expect(bootstrap.getConfigValues()).toEqual({coreUrl: "http://core", oemId: "mentra"})
    expect(bootstrap.getAnalytics()).toBe(analytics)
  })

  it("start()/stop() toggle isStarted (idempotent)", async () => {
    bootstrap.configure({auth: {getSubjectToken: async () => ({token: "t", type: "supabase"})}})
    await bootstrap.start()
    await bootstrap.start()
    expect(bootstrap.isStarted()).toBe(true)
    await bootstrap.stop()
    expect(bootstrap.isStarted()).toBe(false)
  })
})

describe("engine.display.mirror read facade over the display store", () => {
  it("current() returns the store's current display event", () => {
    const event = {view: "main", layout: {layoutType: "text_wall", text: "hi"}}
    useDisplayStore.getState().setDisplayEvent(JSON.stringify(event))
    flushDisplayCoalesceForTests()
    expect(displayMirror.current()).toEqual(event)
  })

  it("onMirror() fires on display change and stops after unsubscribe", () => {
    const cb = jest.fn()
    const unsub = displayMirror.onMirror(cb)
    useDisplayStore.getState().setDisplayEvent(JSON.stringify({view: "main", layout: {layoutType: "text_wall", text: "x"}}))
    flushDisplayCoalesceForTests()
    expect(cb).toHaveBeenCalled()
    unsub()
    cb.mockClear()
    useDisplayStore.getState().setDisplayEvent(JSON.stringify({view: "main", layout: {layoutType: "text_wall", text: "y"}}))
    flushDisplayCoalesceForTests()
    expect(cb).not.toHaveBeenCalled()
  })
})
