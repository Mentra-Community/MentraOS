/**
 * @fileoverview Re-export shim — RestComms now lives in @mentra/engine (moved
 * together with the settings store, its mutually-coupled pair). Kept so existing
 * `@/services/RestComms` default imports resolve unchanged.
 */
export {restComms as default} from "@mentra/engine/internal"
