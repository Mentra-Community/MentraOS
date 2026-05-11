import {registerWebModule, NativeModule} from "expo"

import {CrustModuleEvents} from "./Crust.types"

class CrustModule extends NativeModule<CrustModuleEvents> {
  PI = Math.PI
  async setValueAsync(value: string): Promise<void> {
    this.emit("onChange", {value})
  }
  hello() {
    return "Hello world! 👋"
  }
  showAVRoutePicker(_tintColor?: string | null) {}
  async setNotificationConfig(_enabled: boolean, _blocklist: string[]): Promise<void> {}
  async getInstalledApps() {
    return []
  }
  async getInstalledAppsForNotifications() {
    return []
  }
  async hasNotificationListenerPermission() {
    return false
  }
  async openNotificationListenerSettings() {
    return false
  }
  async isBetaBuild() {
    return false
  }
}

export default registerWebModule(CrustModule, "CrustModule")
