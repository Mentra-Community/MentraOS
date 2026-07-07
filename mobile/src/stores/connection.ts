// Moved into @mentra/island. This shim re-exports the raw store from the
// island internal entry so existing `@/stores/connection` importers stay unchanged.
export {useConnectionStore} from "@mentra/island/internal"
