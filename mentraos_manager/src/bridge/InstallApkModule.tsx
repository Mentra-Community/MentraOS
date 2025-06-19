import {NativeModule, NativeModules} from "react-native"

interface InstallApkModuleInterface extends NativeModule {
  installApk: (packageName: string) => Promise<any>
  downloadCoreApk: () => Promise<string>
}

const {InstallApkModule} = NativeModules

export default InstallApkModule as InstallApkModuleInterface
