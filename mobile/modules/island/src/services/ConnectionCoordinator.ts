/**
 * ConnectionCoordinator — the connection *decisions* that were duplicated across
 * the reconnect effect and the connect/disconnect buttons.
 *
 * Pure logic: callers gather the inputs from their stores and perform the IO
 * (permission prompts, bluetooth calls, navigation) themselves. Centralizing the
 * decisions keeps the "when do we (re)connect / cancel / go to pairing" rules in
 * one tested place instead of re-deriving them in home.tsx, DeviceStatus, the
 * reconnect effect, and the connect buttons.
 *
 */
export interface ReconnectDecisionInput {
  /** The reconnect_on_app_foreground setting. */
  reconnectOnForeground: boolean
  /** The default_wearable setting (model id), if any. */
  defaultWearable: string | null | undefined
  /** True when defaultWearable is the simulated device. */
  isSimulated: boolean
  /** True when the glasses BLE link is already connected. */
  connected: boolean
  /** True while the native link layer is mid scan / connect / bond. */
  nativeLinkBusy: boolean
  /** True when the SDK holds an actual default device (connectDefault target). */
  hasDefaultDevice: boolean
  /** True when a scan is already in progress. */
  searching: boolean
}

/**
 * "skip" means do not connect — the caller returns `result` (preserving the
 * original true/false contract of attemptReconnect). "connect" means proceed to
 * the permission check + connectDefault().
 */
export type ReconnectDecision = {kind: "skip"; result: boolean} | {kind: "connect"}

export function decideReconnect(input: ReconnectDecisionInput): ReconnectDecision {
  // Reconnect-on-foreground disabled: treat as a no-op success.
  if (!input.reconnectOnForeground) return {kind: "skip", result: true}
  // No real wearable paired (or the simulated device): nothing to reconnect to.
  if (!input.defaultWearable || input.isSimulated) return {kind: "skip", result: false}
  // Model chosen but never actually paired (or the native default was cleared):
  // connectDefault() would throw — skip quietly; pairing is a user-driven flow.
  // (Safe to trust at cold start now: hasDefaultDevice reads are gated on the
  // device-store hydration completing, and callers fail open on rejection.)
  if (!input.hasDefaultDevice) return {kind: "skip", result: false}
  // Already connected, or a scan/connect/bond is already in flight: starting a
  // second connectDefault() on top of the busy link layer would collide with it
  // (same busy rule as decideConnectButtonAction).
  if (input.connected || input.searching || input.nativeLinkBusy) return {kind: "skip", result: true}
  return {kind: "connect"}
}

export type ConnectButtonAction = "cancel" | "pair" | "connect"

/**
 * What a connect/disconnect button should do when tapped:
 * - "cancel"  — a scan/connect is in flight; the tap cancels it (disconnect)
 * - "pair"    — no device is paired yet; the tap goes to the pairing flow
 * - "connect" — a device is paired and idle; the tap connects to it
 */
export function decideConnectButtonAction(input: {hasDefaultWearable: boolean; busy: boolean}): ConnectButtonAction {
  if (input.busy) return "cancel"
  if (!input.hasDefaultWearable) return "pair"
  return "connect"
}
