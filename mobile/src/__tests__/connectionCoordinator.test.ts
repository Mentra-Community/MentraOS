// Imports the real ConnectionCoordinator by path (not via "@mentra/island",
// which jest mocks) so the actual decisions run under the mobile jest CI runner.
import {decideConnectButtonAction, decideReconnect} from "../../modules/island/src/services/ConnectionCoordinator"
import type {GlassesConnectionStatus} from "../../modules/island/src/services/GlassesReadiness"

const connected: GlassesConnectionStatus = {state: "connected", fullyBooted: true}
const disconnected: GlassesConnectionStatus = {state: "disconnected"}

describe("decideReconnect", () => {
  const base = {
    reconnectOnForeground: true,
    defaultWearable: "Even Realities G1",
    isSimulated: false,
    connection: disconnected,
    searching: false,
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
    expect(decideReconnect({...base, connection: connected})).toEqual({kind: "skip", result: true})
  })

  it("skips when already searching", () => {
    expect(decideReconnect({...base, searching: true})).toEqual({kind: "skip", result: true})
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
