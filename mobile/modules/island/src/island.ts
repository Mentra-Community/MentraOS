/**
 * `toolkit` — the namespaced OEM-facing toolkit API (the "(A) host API" from the
 * Phase-1 contract). Host UI calls `toolkit.<domain>.<method>()`; each domain is a
 * typed facade over the runtime. (Exported from the `@mentra/island` module, whose
 * name stays `island` in code; the public API surface is `toolkit`.)
 *
 * This is additive: it grows one facade at a time and lives *alongside* the flat
 * named exports in `index.ts` during the migration. The flat exports (and the
 * `BluetoothSdk` passthrough) stay until every screen has moved onto `island.*`.
 */
import {configure, start, stop} from "./runtime/bootstrap"
import {glasses} from "./facades/glasses"
import {displayMirror} from "./facades/displayMirror"
import {speech} from "./facades/speech"
import {session} from "./facades/session"
import {settings} from "./facades/settings"
import {dev} from "./facades/dev"
import {incidents} from "./facades/incidents"
import {useGlassesStore} from "./stores/glasses"
import {useDisplayStore} from "./stores/display"
import {useCoreStore} from "./stores/core"
import {useConnectionStore} from "./stores/connection"
import {useGallerySyncStore} from "./stores/gallerySync"
import {useCloudClientStatusStore} from "./stores/cloudClientStatus"
import {useSettingsStore} from "./stores/settings"

export const toolkit = {
  /** Front door — hand island auth + config, then start/stop the runtime. */
  configure,
  start,
  stop,
  glasses,
  speech,
  /** Cloud (cloud-v2) live-session status + account ops — island owns the client. */
  session,
  /** Typed keyed user settings over the island-owned settings store. */
  settings,
  /** Developer/debug surface (backend+cloud URL overrides, reconnect, min version). */
  dev,
  /** Bug-report / feedback submission (island-owned RestComms). */
  incidents,
  display: {
    mirror: displayMirror,
  },
  /**
   * Escape hatches — the raw device-state zustand stores, grouped under `stores`,
   * exposed so the Mentra app keeps using them directly instead of rewriting every
   * screen onto typed facades. These are Mentra-app convenience, NOT the OEM
   * contract — OEMs use the typed facades above. Prefer a facade where one exists.
   */
  stores: {
    glasses: useGlassesStore,
    display: useDisplayStore,
    core: useCoreStore,
    connection: useConnectionStore,
    gallerySync: useGallerySyncStore,
    cloudClientStatus: useCloudClientStatusStore,
    settings: useSettingsStore,
  },
}
