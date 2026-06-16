// Imports the real bootstrap + displayMirror by path (not via "@mentra/island",
// which jest mocks) so the actual logic runs under the mobile jest CI runner.
import * as bootstrap from "../../modules/island/src/runtime/bootstrap"
import {displayMirror} from "../../modules/island/src/facades/displayMirror"

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

describe("island.display.mirror read-model", () => {
  it("ingest() sets current() and notifies subscribers", () => {
    const seen: unknown[] = []
    const unsub = displayMirror.onMirror((e) => seen.push(e))
    const event = {view: "main", layout: {layoutType: "text_wall", text: "hi"}}
    displayMirror.ingest(event)
    expect(displayMirror.current()).toBe(event)
    expect(seen).toEqual([event])
    unsub()
  })

  it("onMirror() unsubscribe stops delivery", () => {
    const cb = jest.fn()
    const unsub = displayMirror.onMirror(cb)
    unsub()
    displayMirror.ingest({view: "dashboard"})
    expect(cb).not.toHaveBeenCalled()
  })
})
