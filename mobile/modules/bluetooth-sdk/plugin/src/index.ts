import {type ConfigPlugin} from "expo/config-plugins"

import {withAndroidConfiguration} from "./withAndroid"
import {withIosConfiguration} from "./withIos"

export interface BluetoothSdkPluginProps {
  node?: boolean
  analytics?: boolean | BluetoothSdkAnalyticsPluginProps
}

export interface BluetoothSdkAnalyticsPluginProps {
  enabled?: boolean
  /**
   * Host-declared build lane (`dev`, `staging`, `prod`, ...), reported as
   * `app_environment` on every SDK analytics event. Trimmed and lowercased;
   * must then start with a letter or digit, followed by letters, digits, `_`
   * or `-`, at most 32 characters. Store/TestFlight/sideload detection is
   * automatic; this only adds the lane the host itself knows about.
   */
  environment?: string
}

const withBluetoothSdk: ConfigPlugin<BluetoothSdkPluginProps> = (config, props) => {
  // Apply Android configurations
  config = withAndroidConfiguration(config, props)

  // Apply iOS configurations
  config = withIosConfiguration(config, props)

  return config
}

export default withBluetoothSdk
