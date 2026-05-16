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
  async mentraJsSpawn(_pkg: string, _polyfill: string, _miniappJs: string) {
    return false
  }
  async mentraJsEvaluate(_pkg: string, _src: string) {
    return null
  }
  async mentraJsKill(_pkg: string) {
    return
  }
  async mentraJsDispatchToJs(_pkg: string, _env: Record<string, unknown>) {
    return
  }
  async mentraJsSetManifest(_pkg: string, _perms: string[]) {
    return
  }
  mentraJsAlivePackages() {
    return []
  }
  async mentraJsDebugForceGC(_pkg: string) {
    return false
  }
  mentraJsLoadPolyfillBundle() {
    return ""
  }
}

export default registerWebModule(CrustModule, "CrustModule")
