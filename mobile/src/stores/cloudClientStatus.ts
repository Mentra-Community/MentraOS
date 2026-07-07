/**
 * @fileoverview Re-export shim — the cloud-client runtime status store now lives
 * in @mentra/island (island owns the cloud-v2 runtime status). Kept so existing
 * `@/stores/cloudClientStatus` imports resolve unchanged.
 */
export {useCloudClientStatusStore} from "@mentra/island/internal"
export type {RuntimeAudioTransport, RuntimeSnapshot, RuntimeStatus} from "@mentra/island/internal"
