import {type ConfigPlugin} from "expo/config-plugins"

import {withCrustAndroidBuildContract} from "./withAndroid"
import withMapboxNavCrustLink from "./withMapboxNavCrustLink"
import withMapboxNavIos from "./withMapboxNavIos"

/**
 * @mentra/crust config plugin — the module's native build contract, so
 * every host that embeds crust (the Mentra app, the example OEM app, real OEM
 * hosts) inherits it by listing "@mentra/crust" in `app.json` plugins instead
 * of hand-mirroring gradle edits:
 *
 * - the authenticated Mapbox Downloads Maven repo (crust bundles the Mapbox
 *   Navigation SDK, whose artifacts exist only in Mapbox's private registry;
 *   the MAPBOX_DOWNLOADS_TOKEN env / gradle property authenticates it at
 *   dependency-resolution time — build-time only, never in the APK)
 * - a global protobuf-javalite exclusion (the bluetooth-sdk/crust native stack
 *   needs protobuf-java; Mapbox drags protobuf-javalite transitively; shipping
 *   both fails the release build with duplicate classes)
 * - core-library desugaring (crust's AAR metadata requires it of embedding
 *   apps — the Nav SDK uses newer core libs)
 * - a generated MainApplication process guard so the notification-listener
 *   process never initializes React Native
 * - iOS Mapbox Swift Package products and the Crust build-order dependency
 */
const withCrust: ConfigPlugin = (config) => {
  return withMapboxNavCrustLink(withMapboxNavIos(withCrustAndroidBuildContract(config)))
}

export default withCrust
