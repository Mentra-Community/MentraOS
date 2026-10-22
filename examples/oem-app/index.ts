import {registerRootComponent} from "expo"

import App from "./App"

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in a development build or a
// production native build, the environment is set up appropriately.
registerRootComponent(App)
