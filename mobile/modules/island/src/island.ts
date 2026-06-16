/**
 * `island` — the namespaced OEM-facing toolkit API (the "(A) host API" from the
 * Phase-1 contract). Host UI calls `island.<domain>.<method>()`; each domain is a
 * typed facade over the runtime.
 *
 * This is additive: it grows one facade at a time and lives *alongside* the flat
 * named exports in `index.ts` during the migration. The flat exports (and the
 * `BluetoothSdk` passthrough) stay until every screen has moved onto `island.*`.
 */
import {configure, start, stop} from "./runtime/bootstrap"
import {glassesWifi} from "./facades/glassesWifi"
import {displayMirror} from "./facades/displayMirror"

export const island = {
  /** Front door — hand island auth + config, then start/stop the runtime. */
  configure,
  start,
  stop,
  glasses: {
    wifi: glassesWifi,
  },
  display: {
    mirror: displayMirror,
  },
}
