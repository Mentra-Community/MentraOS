// The display/mirror store moved into @mentra/island (island owns the read-model
// of what's on the glasses screen). This shim re-exports it so existing
// `@/stores/display` importers keep working unchanged — the Mentra-app escape hatch.
// New code reads it via the typed `toolkit.display.mirror` facade.
export {useDisplayStore} from "@mentra/island/internal"
