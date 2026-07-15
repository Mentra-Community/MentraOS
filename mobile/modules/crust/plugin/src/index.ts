import {type ConfigPlugin} from "expo/config-plugins"

import {withCrustAndroidBuildContract} from "./withAndroid"

export interface CrustPluginProps {
  /**
   * Compile crust's Mapbox Navigation SDK dependency INTO the app (turn-by-turn
   * nav). Default `false`: a host that doesn't navigate builds credential-free —
   * the Mapbox Downloads repo is not injected and the Nav SDK is `compileOnly`
   * (crust compiles, but the classes aren't in the APK, so no
   * `MAPBOX_DOWNLOADS_TOKEN` is needed). The Mentra app passes `true`.
   *
   * When `false`, crust's native `startNavigation`/`stopNavigation` return a
   * clean "navigation not available in this build" error instead of running.
   */
  navigation?: boolean
}

/**
 * @mentra/crust config plugin — the module's own Android build contract, so
 * every host that embeds crust (the Mentra app, the example OEM app, real OEM
 * hosts) inherits it by listing "@mentra/crust" in `app.json` plugins instead
 * of hand-mirroring gradle edits:
 *
 * - a global protobuf-javalite exclusion (the bluetooth-sdk/crust native stack
 *   needs protobuf-java; Mapbox drags protobuf-javalite transitively; shipping
 *   both fails the release build with duplicate classes) — always applied.
 * - core-library desugaring (crust's AAR metadata requires it of embedding
 *   apps) — always applied.
 * - the authenticated Mapbox Downloads Maven repo — applied ONLY when
 *   `navigation` is enabled (the Nav SDK's artifacts live in Mapbox's private
 *   registry behind MAPBOX_DOWNLOADS_TOKEN; a non-navigating host must not need
 *   that credential to build).
 *
 * The `navigation` choice is also passed to crust's gradle as the
 * `mentraCrustNavigation` property, which flips the Nav SDK dependency between
 * `implementation` (in the APK) and `compileOnly` (compiled against, absent at
 * runtime).
 */
const withCrust: ConfigPlugin<CrustPluginProps | void> = (config, props) => {
  const navigation = props?.navigation ?? false
  return withCrustAndroidBuildContract(config, {navigation})
}

export default withCrust
