/**
 * Re-export shim — the process-wide event bus now lives in @mentra/engine (one
 * shared instance for island services + host). Kept so existing
 * `@/utils/GlobalEventEmitter` default imports resolve unchanged.
 *
 * @deprecated Use BluetoothSDK subscriptions directly instead.
 */
export {GlobalEventEmitter as default} from "@mentra/engine/internal"
