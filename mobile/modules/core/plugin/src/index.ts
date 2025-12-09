import {type ConfigPlugin} from "expo/config-plugins"

import {withAndroidConfiguration} from "./withAndroid"
import {withIosConfiguration} from "./withIos"

export interface CorePluginProps {
  node?: boolean
}

const withCore: ConfigPlugin<CorePluginProps> = (config, props) => {
  // Apply Android configurations
  config = withAndroidConfiguration(config, props)

  // Apply iOS configurations
  config = withIosConfiguration(config, props)

  return config
}

export default withCore
