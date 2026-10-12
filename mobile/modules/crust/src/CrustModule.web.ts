import {registerWebModule, NativeModule} from "expo"

import {CrustModuleEvents} from "./Crust.types"

class CrustModule extends NativeModule<CrustModuleEvents> {
  PI = Math.PI
  private readonly httpRequests = new Map<string, AbortController>()
  async setValueAsync(value: string): Promise<void> {
    this.emit("onChange", {value})
  }
  async nativeHttpRequest(requestId: string, method: string, url: string, headers: Record<string, string>, body?: string | null) {
    const controller = new AbortController()
    this.httpRequests.set(requestId, controller)
    try {
      const response = await fetch(url, {method, headers, body, signal: controller.signal})
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      }
    } finally {
      this.httpRequests.delete(requestId)
    }
  }
  async cancelNativeHttpRequest(requestId: string): Promise<void> {
    this.httpRequests.get(requestId)?.abort()
    this.httpRequests.delete(requestId)
  }
  hello() {
    return "Hello world! 👋"
  }
  showAVRoutePicker(_tintColor?: string | null) {}
  async setDeferredSystemGestures(_edges: string[]): Promise<void> {}
  async setNotificationConfig(_listenerEnabled: boolean, _blocklist: string[]): Promise<void> {}
  async getInstalledApps() {
    return []
  }
  async getInstalledAppsForNotifications() {
    return []
  }
  async hasNotificationListenerPermission() {
    return false
  }
  async refreshNotificationListener() {
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
