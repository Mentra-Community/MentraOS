// Imports the real ConnectionCoordinator by path (not via "@mentra/engine",
// which jest mocks) so the actual decisions run under the mobile jest CI runner.
import {decideConnectButtonAction, decideReconnect} from "../../modules/engine/src/services/ConnectionCoordinator"

describe("decideReconnect", () => {
  const base = {
    reconnectOnForeground: true,
    defaultWearable: "Even Realities G1",
    isSimulated: false,
    connected: false,
    searching: false,
    nativeLinkBusy: false,
    hasDefaultDevice: true,
  }

  it("skips as a no-op success when reconnect-on-foreground is off", () => {
    expect(decideReconnect({...base, reconnectOnForeground: false})).toEqual({kind: "skip", result: true})
  })

  it("skips as not-applicable when no wearable is paired", () => {
    expect(decideReconnect({...base, defaultWearable: null})).toEqual({kind: "skip", result: false})
  })

  it("skips as not-applicable for the simulated device", () => {
    expect(decideReconnect({...base, isSimulated: true})).toEqual({kind: "skip", result: false})
  })

  it("skips when already connected", () => {
    expect(decideReconnect({...base, connected: true})).toEqual({kind: "skip", result: true})
  })

  it("skips when already searching", () => {
    expect(decideReconnect({...base, searching: true})).toEqual({kind: "skip", result: true})
  })

  it("skips when the native link layer is mid connect/bond (no scan running)", () => {
    expect(decideReconnect({...base, nativeLinkBusy: true})).toEqual({kind: "skip", result: true})
  })

  it("skips quietly when a model is chosen but no device was ever paired", () => {
    expect(decideReconnect({...base, hasDefaultDevice: false})).toEqual({kind: "skip", result: false})
  })

  it("connects while the SDK reports the normal pairing state", () => {
    expect(decideReconnect({...base, pairingState: {state: "normal"}})).toEqual({kind: "connect"})
  })

  it("skips while the SDK pairing window is open (reconnect is paused)", () => {
    const pairingState = {state: "pairing_mode" as const, windowId: 7, endsAtMs: 2_000}
    expect(decideReconnect({...base, pairingState, now: 1_000})).toEqual({kind: "skip", result: true})
  })

  it("connects once a stale pairing window has passed its end", () => {
    const pairingState = {state: "pairing_mode" as const, windowId: 7, endsAtMs: 2_000}
    expect(decideReconnect({...base, pairingState, now: 2_000})).toEqual({kind: "connect"})
  })

  it("skips after the SDK reports the glasses rejected this phone (Pair Again owns recovery)", () => {
    expect(decideReconnect({...base, pairingState: {state: "pairing_rejected"}})).toEqual({kind: "skip", result: true})
  })

  it("connects when paired, idle, and disconnected", () => {
    expect(decideReconnect(base)).toEqual({kind: "connect"})
  })
})

describe("decideConnectButtonAction", () => {
  it("cancels when busy, regardless of pairing", () => {
    expect(decideConnectButtonAction({hasDefaultWearable: true, busy: true})).toBe("cancel")
    expect(decideConnectButtonAction({hasDefaultWearable: false, busy: true})).toBe("cancel")
  })

  it("goes to pairing when idle and nothing is paired", () => {
    expect(decideConnectButtonAction({hasDefaultWearable: false, busy: false})).toBe("pair")
  })

  it("connects when idle and a device is paired", () => {
    expect(decideConnectButtonAction({hasDefaultWearable: true, busy: false})).toBe("connect")
  })
})
