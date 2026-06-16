/**
 * `island` — the namespaced OEM-facing toolkit API (the "(A) host API" from the
 * Phase-1 contract). Host UI calls `island.<domain>.<method>()`; each domain is a
 * typed facade over the runtime.
 *
 * This is additive: it grows one facade at a time and lives *alongside* the flat
 * named exports in `index.ts` during the migration. The flat exports (and the
 * `BluetoothSdk` passthrough) stay until every screen has moved onto `island.*`.
 *
 * First member: `island.glasses.wifi`. The bootstrap front door
 * (`island.configure`/`start`/`stop`) and the remaining domains attach here in
 * follow-up PRs.
 */
import {glassesWifi} from "./facades/glassesWifi"

export const island = {
  glasses: {
    wifi: glassesWifi,
  },
}
