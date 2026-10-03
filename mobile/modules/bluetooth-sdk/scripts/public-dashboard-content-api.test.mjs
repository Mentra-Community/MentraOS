import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const readPackageFile = (relativePath) => readFileSync(path.join(packageRoot, relativePath), "utf8")

test("publishes setDashboardContent on React Native and native SDK surfaces", () => {
  const publicTypes = readPackageFile("src/BluetoothSdk.types.ts")
  const publicRoot = readPackageFile("src/index.ts")
  const privateModule = readPackageFile("src/_private/BluetoothSdkModule.ts")
  const androidModule = readPackageFile("android/src/main/java/com/mentra/bluetoothsdk/BluetoothSdkModule.kt")
  const androidSdk = readPackageFile("android/src/main/java/com/mentra/bluetoothsdk/MentraBluetoothSdk.kt")
  const appleModule = readPackageFile("ios/BluetoothSdkModule.swift")
  const appleSdk = readPackageFile("ios/Source/MentraBluetoothSDK.swift")

  assert.match(publicTypes, /setDashboardContent\(content: string\): Promise<void>/)
  assert.match(publicRoot, /setDashboardContent: bindPublicMethod\("setDashboardContent"\)/)
  assert.match(privateModule, /setDashboardContent\(content: string\): Promise<void>/)
  assert.match(androidModule, /SdkAsyncFunction\("setDashboardContent"\)/)
  assert.match(androidSdk, /fun setDashboardContent\(content: String\)/)
  assert.match(appleModule, /AsyncFunction\("setDashboardContent"\)/)
  assert.match(appleSdk, /public func setDashboardContent\(_ content: String\) async/)
})

test("keeps displayEvent internal and defers dashboard scene cleanup until rendering", () => {
  const publicTypes = readPackageFile("src/BluetoothSdk.types.ts")
  const publicRoot = readPackageFile("src/index.ts")
  const androidSdk = readPackageFile("android/src/main/java/com/mentra/bluetoothsdk/MentraBluetoothSdk.kt")
  const androidManager = readPackageFile("android/src/main/java/com/mentra/bluetoothsdk/DeviceManager.kt")
  const appleSdk = readPackageFile("ios/Source/MentraBluetoothSDK.swift")
  const appleManager = readPackageFile("ios/Source/DeviceManager.swift")

  assert.doesNotMatch(publicTypes, /\bdisplayEvent\(/)
  assert.doesNotMatch(publicRoot, /\bdisplayEvent\b/)
  assert.match(androidSdk, /internal fun displayEvent\(/)
  assert.doesNotMatch(androidSdk, /public fun displayEvent\(/)
  assert.match(appleSdk, /\n\s+func displayEvent\(/)
  assert.doesNotMatch(appleSdk, /public func displayEvent\(/)

  const androidSetter = androidManager.slice(
    androidManager.indexOf("internal fun setDashboardContent"),
    androidManager.indexOf("private fun clearPendingDashboardSceneElements"),
  )
  const appleSetter = appleManager.slice(
    appleManager.indexOf("func setDashboardContent"),
    appleManager.indexOf("private func clearPendingDashboardSceneElements"),
  )
  assert.match(androidSetter, /if \(headUp && contextualDashboard\)/)
  assert.match(appleSetter, /if headUp && contextualDashboard/)
  assert.match(androidSetter, /pendingDashboardSceneElementIds\.addAll/)
  assert.match(appleSetter, /pendingDashboardSceneElementIds\.formUnion/)
  assert.match(androidSetter, /dashboardSceneCleanupPending = true/)
  assert.match(appleSetter, /dashboardSceneCleanupPending = true/)
  assert.doesNotMatch(androidSetter, /clearSceneElements/)
  assert.doesNotMatch(appleSetter, /clearSceneElements/)
  assert.doesNotMatch(androidSetter, /showDashboard/)
  assert.doesNotMatch(appleSetter, /showDashboard/)

  assert.match(androidManager, /clearPendingDashboardSceneElements\(currentStateIndex\)/)
  assert.match(appleManager, /await clearPendingDashboardSceneElements\(for:/)
  assert.match(
    androidManager,
    /private fun dispatchSceneFrame[\s\S]*?clearPendingDashboardSceneElements\(stateIndex\)/,
  )
  assert.match(
    appleManager,
    /private func dispatchSceneFrame[\s\S]*?await (?:self\.)?renderCurrentState\(\)/,
  )
  assert.match(androidManager, /cleanupDeferred = stateIndex == 1 && dashboardSceneCleanupPending/)
  assert.match(appleManager, /cleanupDeferred = stateIndex == 1 && dashboardSceneCleanupDeferred/)
})
