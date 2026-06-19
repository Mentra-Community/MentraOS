// Re-export shim — OTA manifest-URL resolution moved into @mentra/island (island
// owns its OTA manifest resolution). Kept so existing `@/services/asg/asgOtaVersionUrl`
// importers (OTA screens, OtaUpdateChecker) keep working unchanged.
export {getAsgOtaVersionUrl} from "@mentra/island"
