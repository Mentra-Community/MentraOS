import BackendServerComms from "../backend_comms/BackendServerComms"
import {AppStoreItem} from "../components/types.ts"
import {GET_APP_STORE_DATA_ENDPOINT} from "../consts"

const backendServerComms = BackendServerComms.getInstance()

/**
 * A utility function that fetches the app store data and returns a Promise.
 *
 * @returns Promise<AppStoreItem[]> - Resolves with the store data.
 */
export const fetchAppStoreData = async (): Promise<AppStoreItem[]> => {
  return new Promise<AppStoreItem[]>((resolve, reject) => {
    const callback = {
      onSuccess: (data: AppStoreItem[]) => {
        resolve(data)
      },
      onFailure: (error: any) => {
        console.error("Failed to fetch app store data:", error)
        reject(error)
      },
    }

    try {
      backendServerComms.restRequest(GET_APP_STORE_DATA_ENDPOINT, null, callback).catch((error: any) => {
        console.error("Error during restRequest:", error)
        reject(error)
      })
    } catch (error) {
      console.error("Error during restRequest:", error)
      reject(error)
    }
  })
}
