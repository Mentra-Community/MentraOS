// backend_comms/BackendServerComms.ts
import axios, {AxiosRequestConfig} from "axios"
import {Config} from "react-native-config"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {loadSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"
import {AppInterface} from "@/contexts/AppStatusProvider"
import Toast from "react-native-toast-message"
import {translate} from "@/i18n"
import {colors} from "@/theme"
import {TruckIcon} from "assets/icons/component/TruckIcon"

interface Callback {
  onSuccess: (data: any) => void
  onFailure: (errorCode: number) => void
}

export default class BackendServerComms {
  private static instance: BackendServerComms
  private TAG = "MXT2_BackendServerComms"
  private coreToken: string | null = null

  public async getServerUrl(): Promise<string> {
    const customUrl = await loadSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, null)

    if (customUrl && typeof customUrl === "string" && customUrl.trim() !== "") {
      console.log(`${this.TAG}: Using custom backend URL: ${customUrl}`)
      return customUrl
    }

    // const secure = Config.MENTRAOS_SECURE === 'true';
    // const host = Config.MENTRAOS_HOST;
    // const port = Config.MENTRAOS_PORT;
    const secure = true
    const host = "global.mentra.glass"
    const port = "443"
    const protocol = secure ? "https" : "http"
    const defaultServerUrl = `${protocol}://${host}:${port}`
    console.log(`${this.TAG}: Using default backend URL from env: ${defaultServerUrl}`)
    return defaultServerUrl
  }

  /**
   * Fetch gallery photos from the server
   * @returns Promise that resolves to gallery photos
   */
  public async getGalleryPhotos(): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const url = `${await this.getServerUrl()}/api/gallery`
    console.log("Fetching gallery photos from:", url)

    const config: AxiosRequestConfig = {
      method: "GET",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        console.log("Received gallery photos:", response.data)
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error fetching gallery photos:", error.message || error)
      throw error
    }
  }

  /**
   * Delete a photo from the gallery
   * @param photoId ID of the photo to delete
   * @returns Promise that resolves to success status
   */
  public async deleteGalleryPhoto(photoId: string): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const url = `${this.serverUrl}/api/gallery/${photoId}`
    console.log("Deleting gallery photo:", photoId)

    const config: AxiosRequestConfig = {
      method: "DELETE",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        console.log("Photo deleted successfully:", photoId)
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error deleting photo:", error.message || error)
      throw error
    }
  }

  private constructor() {
    // No need to set serverUrl here anymore
  }

  public static getInstance(): BackendServerComms {
    if (!BackendServerComms.instance) {
      BackendServerComms.instance = new BackendServerComms()
    }
    return BackendServerComms.instance
  }

  public setCoreToken(token: string | null): void {
    this.coreToken = token
    console.log(
      `${this.TAG}: Core token ${token ? "set" : "cleared"} - Length: ${token?.length || 0} - First 20 chars: ${token?.substring(0, 20) || "null"}`,
    )

    // When a core token is set, trigger app refresh via global event
    if (token) {
      console.log(`${this.TAG}: Core token set, emitting CORE_TOKEN_SET event`)
      GlobalEventEmitter.emit("CORE_TOKEN_SET")
    }
  }

  public getCoreToken(): string | null {
    return this.coreToken
  }

  public async restRequest(endpoint: string, data: any, callback: Callback): Promise<void> {
    try {
      const baseUrl = await this.getServerUrl()
      const url = baseUrl + endpoint

      // Axios request configuration
      const config: AxiosRequestConfig = {
        method: data ? "POST" : "GET",
        url: url,
        headers: {
          "Content-Type": "application/json",
        },
        ...(data && {data}),
      }

      // Make the request
      const response = await axios(config)

      if (response.status === 200) {
        const responseData = response.data
        if (responseData) {
          callback.onSuccess(responseData)
        } else {
          callback.onFailure(-1)
        }
      } else {
        console.log(`${this.TAG}: Error - ${response.statusText}`)
        callback.onFailure(response.status)
      }
    } catch (error: any) {
      console.log(`${this.TAG}: Network Error -`, error.message || error)
      callback.onFailure(-1)
    }
  }

  /**
   * Send error report to backend server
   * @param reportData The error report data
   * @returns Promise resolving to the response data, or rejecting with an error
   */
  public async sendErrorReport(reportData: any): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/app/error-report`
    console.log("Sending error report to:", url)

    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
      data: reportData,
    }

    try {
      const response = await axios(config)
      if (response.status === 200) {
        return response.data
      } else {
        throw new Error(`Error sending report: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error(`${this.TAG}: Error sending report -`, error.message || error)
      throw error
    }
  }

  public async exchangeToken(supabaseToken: string): Promise<string> {
    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/auth/exchange-token`
    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {"Content-Type": "application/json"},
      data: {supabaseToken},
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        this.setCoreToken(response.data.coreToken)
        return response.data.coreToken
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (err) {
      throw err
    }
  }

  public async getTpaSettings(tpaName: string): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/tpasettings/${tpaName}`
    console.log("Fetching TPA settings from:", url)

    const config: AxiosRequestConfig = {
      method: "GET",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        console.log("Received TPA settings:", response.data)
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error fetching TPA settings:", error.message || error)
      throw error
    }
  }

  // New method to update a TPA setting on the server.
  public async updateTpaSetting(tpaName: string, update: {key: string; value: any}): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/tpasettings/${tpaName}`
    console.log("Updating TPA settings via:", url)

    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
      data: update,
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        console.log("Updated TPA settings:", response.data)
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error updating TPA settings:", error.message || error)
      throw error
    }
  }

  /**
   * Start an app using the REST API
   * @param packageName Package name of the app to start
   * @returns Response including app state
   */
  public async startApp(packageName: string): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/apps/${packageName}/start`
    console.log("Starting app:", packageName)

    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        console.log("App started successfully:", packageName)
        // showToast();
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      //console.error('Error starting app:', error.message || error);
      GlobalEventEmitter.emit("SHOW_BANNER", {message: "Error starting app: " + error.message || error, type: "error"})
      GlobalEventEmitter.emit("SHOW_BANNER", {
        message: `Could not connect to ${packageName}`,
        type: "error",
      })
      throw error
    }
  }

  /**
   * Stop an app using the REST API
   * @param packageName Package name of the app to stop
   * @returns Response including app state
   */
  public async stopApp(packageName: string): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/apps/${packageName}/stop`
    console.log("Stopping app:", packageName)

    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        console.log("App stopped successfully:", packageName)
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error stopping app:", error.message || error)
      throw error
    }
  }

  /**
   * Uninstall an app using the REST API
   * @param packageName Package name of the app to uninstall
   * @returns Response including uninstallation status
   */
  public async uninstallApp(packageName: string): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/api/apps/uninstall/${packageName}`
    console.log("Uninstalling app:", packageName)

    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        console.log("App uninstalled successfully:", packageName)
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error uninstalling app:", error.message || error)
      throw error
    }
  }

  /**
   * Fetch all available apps
   * @returns Promise with the apps data
   */
  public async getApps(): Promise<AppInterface[]> {
    console.log(`${this.TAG}: getApps() called`)
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/api/apps/`
    console.log(`${this.TAG}: Fetching apps from URL: ${url}`)

    const config: AxiosRequestConfig = {
      method: "GET",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    // console.log(`${this.TAG}: Authorization header: Bearer ${this.coreToken?.substring(0, 20)}...`);

    try {
      // console.log(`${this.TAG}: Making axios request to ${url}`);
      const response = await axios(config)
      console.log(`${this.TAG}: Received response with status: ${response.status}`)

      if (response.status === 200 && response.data) {
        // console.log(`${this.TAG}: Response data:`, response.data);
        if (response.data.success && response.data.data) {
          // console.log(`${this.TAG}: Successfully fetched ${response.data.data.length} apps`);
          return response.data.data
        } else {
          // console.error(`${this.TAG}: Invalid response format:`, response.data);
          throw new Error("Invalid response format")
        }
      } else {
        // console.error(`${this.TAG}: Bad response status: ${response.status} - ${response.statusText}`);
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      // console.error(`${this.TAG}: Error fetching apps:`, error.message || error);
      throw error
    }
  }

  /**
   * Requests a temporary, single-use token for webview authentication.
   * @param packageName The package name of the TPA the token is for.
   * @returns Promise resolving to the temporary token string.
   * @throws Error if the request fails or no core token is available.
   */
  public async generateWebviewToken(packageName: string, endpoint: string = "generate-webview-token"): Promise<string> {
    if (!this.coreToken) {
      throw new Error("Authentication required: No core token available.")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/api/auth/${endpoint}`
    console.log("Requesting webview token for:", packageName, "at URL:", url)

    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`, // Use the stored coreToken
      },
      data: {packageName}, // Send the target package name in the body
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data.success && response.data.token) {
        console.log(`Received temporary webview token for ${packageName}`)
        return response.data.token
      } else {
        throw new Error(`Failed to generate webview token: ${response.data.error || response.statusText}`)
      }
    } catch (error: any) {
      console.error(`${this.TAG}: Error generating webview token -`, error.message || error)
      // Consider more specific error handling based on response status if available
      if (axios.isAxiosError(error) && error.response) {
        throw new Error(`Failed to generate webview token: ${error.response.data?.error || error.message}`)
      }
      throw error // Re-throw the original error or a new one
    }
  }

  public async hashWithApiKey(stringToHash: string, packageName: string): Promise<string> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/api/auth/hash-with-api-key`

    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
      data: {
        stringToHash,
        packageName,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data.success) {
        return response.data.hash
      } else {
        throw new Error(`Failed to generate hash: ${response.data.error || response.statusText}`)
      }
    } catch (error: any) {
      console.error(`${this.TAG}: Error generating hash:`, error.message || error)
      throw error
    }
  }

  public async requestAccountDeletion(): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()

    //   1. Request Account Deletion:
    //   - Endpoint: /api/account/request-deletion
    //   - Method: POST
    //   - Payload: { reason?: string }
    //   - Response: Returns a requestId and a message to check email for verification code
    //   - Description: Initiates the account deletion process by creating a deletion request with a verification code

    const url = `${baseUrl}/api/account/request-deletion`
    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error requesting data export:", error.message || error)
      throw error
    }
  }

  //  2. Confirm Account Deletion:
  //   - Endpoint: /api/account/confirm-deletion
  //   - Method: DELETE
  //   - Payload: { requestId: string, confirmationCode: string }
  //   - Response: Confirmation message that the account was deleted
  //   - Description: Completes the account deletion process by verifying the code and deleting the user account

  public async confirmAccountDeletion(requestId: string, confirmationCode: string): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/api/account/confirm-deletion`
    const config: AxiosRequestConfig = {
      method: "DELETE",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
      data: {requestId, confirmationCode},
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error confirming account deletion:", error.message || error)
      throw error
    }
  }

  //   1. Request Data Export:
  //   - Endpoint: /api/account/request-export
  //   - Method: POST
  //   - Payload: { format: ‘json’ | ‘csv’ }
  //   - Response: Returns an export ID and status information
  //   - Description: Initiates the data export process
  //  2. Get Export Status:
  //   - Endpoint: /api/account/export-status
  //   - Method: GET
  //   - Query Parameters: id (the export ID)
  //   - Response: Status information about the export including downloadUrl when completed
  //   - Description: Checks the status of an export request
  //  3. Download Export:
  //   - Endpoint: /api/account/download-export/:id
  //   - Method: GET
  //   - URL Parameters: id (the export ID)
  //   - Response: The exported file as an attachment
  //   - Description: Downloads the completed export file

  public async requestDataExport(): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/api/account/request-export`
    const config: AxiosRequestConfig = {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
      data: {format: "json"},
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error requesting data export:", error.message || error)
      throw error
    }
  }

  public async getExportStatus(exportId: string): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/api/account/export-status`
    const config: AxiosRequestConfig = {
      method: "GET",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
      params: {id: exportId},
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error getting export status:", error.message || error)
      throw error
    }
  }

  public async downloadExport(exportId: string): Promise<any> {
    if (!this.coreToken) {
      throw new Error("No core token available for authentication")
    }

    const baseUrl = await this.getServerUrl()
    const url = `${baseUrl}/api/account/download-export/${exportId}`
    const config: AxiosRequestConfig = {
      method: "GET",
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.coreToken}`,
      },
    }

    try {
      const response = await axios(config)
      if (response.status === 200 && response.data) {
        return response.data
      } else {
        throw new Error(`Bad response: ${response.statusText}`)
      }
    } catch (error: any) {
      console.error("Error downloading export:", error.message || error)
      throw error
    }
  }
}
// function showToast() {
//   Toast.show({
//     type: "baseToast",
//     text1: translate("home:movedToActive"),
//     position: "bottom",
//     props: {
//       icon: <TruckIcon  color={colors.icon}/>,
//     },
//   })
// }
