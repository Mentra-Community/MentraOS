/**
 * @fileoverview Re-export shim — the cloud-v2 secure credential store now lives
 * in @mentra/engine (island owns cloud-v2 credential storage). Kept so existing
 * `@/utils/cloudClient/MmkvSecureStore` imports resolve unchanged.
 */
export {cloudSecureStore} from "@mentra/engine-host-internal"
