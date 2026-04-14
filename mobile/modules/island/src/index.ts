// export {default} from "./IslandModule"
// export * from "./Island.types"

import {useApps} from "./stores/apps"
import {useActiveApps} from "./stores/apps"

const apps = {
  useApps: useApps,
  useActiveApps: useActiveApps,
}

const IslandModule = {
  apps: {
    useApps: useApps,
  },
}
