// export {default} from "./IslandModule"
// export * from "./Island.types"




function startMiniApp(packageName: string) {
}


function stopMiniApp(packageName: string) {
}

import { useApps } from "./stores/applets"

const IslandModule = {
    // startMiniApp,
    // stopMiniApp,
    apps: {
        useApps: useApps,
    }
}

export const apps = {
    useApps: useApplets,
}