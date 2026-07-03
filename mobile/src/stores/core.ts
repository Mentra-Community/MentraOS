// Moved into @mentra/island. This shim re-exports it so existing `@/stores/core`
// importers stay unchanged — the Mentra-app escape hatch (also toolkit.stores.core).
export {useCoreStore} from "@mentra/island/internal"
