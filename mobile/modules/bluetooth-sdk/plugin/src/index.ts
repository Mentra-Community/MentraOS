import {type ConfigPlugin} from "expo/config-plugins"

import {withAndroidConfiguration} from "./withAndroid"
import {withIosConfiguration} from "./withIos"

export interface BluetoothSdkPluginProps {
  node?: boolean
  analytics?: boolean | BluetoothSdkAnalyticsPluginProps
}

export interface BluetoothSdkAnalyticsPluginProps {
  enabled?: boolean
}

const withBluetoothSdk: ConfigPlugin<BluetoothSdkPluginProps> = (config, props) => {
  // Apply Android configurations
  config = withAndroidConfiguration(config, props)

  // Apply iOS configurations
  config = withIosConfiguration(config, props)

  return config
}

export default withBluetoothSdk
