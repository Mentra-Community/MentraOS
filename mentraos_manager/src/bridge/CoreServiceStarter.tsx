import {NativeModules} from "react-native"

const {ServiceStarter} = NativeModules

export const startExternalService = () => {
  ServiceStarter.startService()
}

export const stopExternalService = () => {
  ServiceStarter.stopService()
}

export const openCorePermissionsActivity = () => {
  ServiceStarter.openPermissionsActivity()
}

export const isMentraOsCoreInstalled = async () => {
  return ServiceStarter.isMentraOsCoreInstalled()
}

export const areAllCorePermissionsGranted = async () => {
  return ServiceStarter.areAllCorePermissionsGranted()
}

export const isLocationServicesEnabled = async () => {
  return ServiceStarter.isLocationEnabled()
}
