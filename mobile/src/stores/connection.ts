// Moved into @mentra/island. This shim re-exports it so existing `@/stores/connection`
// importers stay unchanged — the Mentra-app escape hatch (also toolkit.stores.connection).
export {useConnectionStore} from "@mentra/island/internal"
