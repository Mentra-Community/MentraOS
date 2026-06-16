// The glasses device-state store moved into @mentra/island (island owns device
// state). This shim re-exports it so the ~46 existing `@/stores/glasses` importers
// keep working unchanged — the escape hatch from the Phase-1 plan. New code can use
// `island.glassesStore` / the typed facades directly instead.
export {
  isGlassesConnected,
  isGlassesLinkLayerBusy,
  isGlassesReady,
  selectGlassesConnected,
  selectGlassesReady,
  getGlasesInfoPartial,
  getGlassesSystemTimeMs,
  useGlassesStore,
  waitForGlassesState,
} from "@mentra/island"
