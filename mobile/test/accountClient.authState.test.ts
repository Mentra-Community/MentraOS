/**
 * Auth-state fanout regression tests.
 *
 * The provider used to keep a single callback slot, so the second consumer to
 * call onAuthStateChange() silently replaced the first. Two consumers subscribe
 * in the real app — AuthContext (which navigates off the login screen) and the
 * engine's cloud client via MantleManager — and the engine registers second,
 * because index.tsx awaits mantle.init() after AuthContext has mounted.
 *
 * The user-visible result: a Google SSO handoff stored its tokens and then left
 * the user on the login screen, because the UI never heard SIGNED_IN. Force
 * quitting "fixed" it, since a cold start reads the persisted session directly.
 *
 * These tests pin the two properties that failure violated: every listener is
 * notified, and unsubscribing one leaves the others alone.
 */
import {createAuthStateFanout} from "@/utils/auth/provider/authStateFanout"

// Sessions here only need a token field; the fanout never inspects them.
const session = {token: "t"}

describe("auth state fanout", () => {
  test("notifies every subscriber, not just the most recent", () => {
    const fanout = createAuthStateFanout()
    const ui = jest.fn()
    const engine = jest.fn()

    // Order matters: this is the real registration order (AuthContext mounts,
    // then mantle.init() wires the engine). The UI used to lose here.
    fanout.subscribe(ui)
    fanout.subscribe(engine)

    fanout.emit("SIGNED_IN", session)

    expect(ui).toHaveBeenCalledTimes(1)
    expect(engine).toHaveBeenCalledTimes(1)
  })

  test("unsubscribing one consumer leaves the others subscribed", () => {
    const fanout = createAuthStateFanout()
    const ui = jest.fn()
    const engine = jest.fn()

    const uiSub = fanout.subscribe(ui)
    fanout.subscribe(engine)
    uiSub.unsubscribe()

    fanout.emit("SIGNED_IN", session)

    expect(ui).not.toHaveBeenCalled()
    expect(engine).toHaveBeenCalledTimes(1)
    expect(fanout.size).toBe(1)
  })

  test("a throwing listener does not stop later listeners from being notified", () => {
    const fanout = createAuthStateFanout()
    const boom = jest.fn(() => {
      throw new Error("consumer blew up")
    })
    const engine = jest.fn()

    fanout.subscribe(boom)
    fanout.subscribe(engine)

    fanout.emit("SIGNED_IN", session)

    expect(boom).toHaveBeenCalledTimes(1)
    expect(engine).toHaveBeenCalledTimes(1)
  })

  test("a listener may unsubscribe from inside its own callback", () => {
    const fanout = createAuthStateFanout()
    const engine = jest.fn()
    // Snapshotting before iterating is what makes this safe; without it the set
    // is mutated mid-iteration and a later listener can be skipped.
    const selfRemoving = () => sub.unsubscribe()
    const sub = fanout.subscribe(selfRemoving)
    fanout.subscribe(engine)

    expect(() => fanout.emit("SIGNED_IN", session)).not.toThrow()
    expect(engine).toHaveBeenCalledTimes(1)
    expect(fanout.size).toBe(1)
  })
})
