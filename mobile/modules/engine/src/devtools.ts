/**
 * MentraOS-only devtools surface, re-exported by the private
 * `@mentra/engine-host-internal/devtools` workspace entry.
 *
 * Debug/diagnostic singletons consumed by the Mentra app's internal dev
 * screens (stress test, miniapp dev-server tooling). Never import this from
 * product UI or host services; every `/devtools` import in mobile/src is
 * counted (report-only) by scripts/check-mobile-runtime-boundary.sh.
 */

// Which miniapps the local runtime currently has running (stress-test screen).
export {miniappRunningRegistry} from "./services/MiniappRunningRegistry"
// Dev-server connection bridge for live-reloading local miniapps.
export {default as devServerBridge} from "./services/DevServerBridge"
