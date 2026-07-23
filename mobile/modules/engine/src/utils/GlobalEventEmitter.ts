// @ts-nocheck — `events` (node builtin, RN-polyfilled) ships no types in engine's
// standalone build; the host build resolves them fine.
import {EventEmitter} from "events"

/**
 * Process-wide event bus — moved into engine so engine-owned services (RestComms)
 * and the host share ONE emitter instance across the engine↔host boundary.
 * Re-exported through the host's `@/utils/GlobalEventEmitter` shim.
 *
 * @deprecated Use BluetoothSDK subscriptions directly instead.
 */
const GlobalEventEmitter = new EventEmitter()

export default GlobalEventEmitter
