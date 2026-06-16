// @ts-nocheck — `events` (node builtin, RN-polyfilled) ships no types in island's
// standalone build; the host build resolves them fine.
import {EventEmitter} from "events"

/**
 * Process-wide event bus — moved into island so island-owned services (RestComms)
 * and the host share ONE emitter instance across the island↔host boundary.
 * Re-exported through the host's `@/utils/GlobalEventEmitter` shim.
 *
 * @deprecated Use BluetoothSDK subscriptions directly instead.
 */
const GlobalEventEmitter = new EventEmitter()

export default GlobalEventEmitter
