import {AppletInterface} from "@/../../cloud/packages/types/src"
import axios, {AxiosInstance, AxiosRequestConfig} from "axios"
import {AsyncResult, Result, result as Res} from "typesafe-ts"

import {GlassesInfo} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

interface RequestConfig {
  method: "GET" | "POST" | "DELETE"
  endpoint: string
  data?: any
  params?: any
  requiresAuth?: boolean
}

class RestComms {
  private static instance: RestComms
  private readonly TAG = "RestComms"
  private coreToken: string | null = null
  private axiosInstance: AxiosInstance

  private constructor() {
    this.axiosInstance = axios.create({
      headers: {
        "Content-Type": "application/json",
      },
    })
  }

  public static getInstance(): RestComms {
    if (!RestComms.instance) {
      RestComms.instance = new RestComms()
    }
    return RestComms.instance
  }

  // Token Management
  public setCoreToken(token: string | null): void {
    this.coreToken = token
    console.log(
      `${this.TAG}: Core token ${token ? "set" : "cleared"} - Length: ${token?.length || 0} - First 20 chars: ${
        token?.substring(0, 20) || "null"
      }`,
    )

    if (token) {
      console.log(`${this.TAG}: Core token set, emitting CORE_TOKEN_SET event`)
      GlobalEventEmitter.emit("CORE_TOKEN_SET")
    }
  }

  public getCoreToken(): string | null {
    return this.coreToken
  }

  // Helper Methods
  private validateToken(): Result<void, Error> {
    if (!this.coreToken) {
      return Res.error(new Error("No core token available for authentication"))
    }
    return Res.ok(undefined)
  }

  private createAuthHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.coreToken}`,
    }
  }

  private makeRequest<T>(config: RequestConfig): AsyncResult<T, Error> {
    const {method, endpoint, data, params, requiresAuth = true} = config

    const baseUrl = useSettingsStore.getState().getRestUrl()
    const url = `${baseUrl}${endpoint}`
    console.log(`REST ${method}:${url}`)

    const headers = requiresAuth ? this.createAuthHeaders() : {"Content-Type": "application/json"}

    const axiosConfig: AxiosRequestConfig = {
      method,
      url,
      headers,
      data,
      params,
    }

    return Res.try_async(async () => {
      const res = await this.axiosInstance.request<T>(axiosConfig)
      return res.data
    })
  }

  private authenticatedRequest<T>(config: RequestConfig): AsyncResult<T, Error> {
    let res = this.validateToken()
    if (res.is_error()) {
      return Res.error_async(res.error)
    }
    return this.makeRequest<T>({...config})
  }

  private unauthenticatedRequest<T>(config: RequestConfig): AsyncResult<T, Error> {
    return this.makeRequest<T>({...config, requiresAuth: false})
  }

  // Public API Methods

  public getMinimumClientVersion(): AsyncResult<{required: string; recommended: string}, Error> {
    interface Response {
      success: boolean
      data: {required: string; recommended: string}
    }
    const config: RequestConfig = {
      method: "GET",
      endpoint: "/api/client/min-version",
    }
    const res = this.unauthenticatedRequest<Response>(config)
    return res.map(response => response.data)
  }

  public checkAppHealthStatus(packageName: string): AsyncResult<boolean, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/app-uptime/app-pkg-health-check",
      data: {packageName},
    }

    interface Response {
      success: boolean
    }

    const res = this.authenticatedRequest<Response>(config)
    return res.map(response => response.success)
  }

  public getApplets(): AsyncResult<AppletInterface[], Error> {
    interface Response {
      success: boolean
      data: AppletInterface[]
    }
    const config: RequestConfig = {
      method: "GET",
      endpoint: "/api/client/apps",
    }
    let res = this.authenticatedRequest<Response>(config)
    let data = res.map(response => response.data)
    return data
  }

  public startApp(packageName: string): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: `/apps/${packageName}/start`,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  public stopApp(packageName: string): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: `/apps/${packageName}/stop`,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  public uninstallApp(packageName: string): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: `/api/apps/uninstall/${packageName}`,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  // App Settings
  public getAppSettings(appName: string): AsyncResult<any, Error> {
    const config: RequestConfig = {
      method: "GET",
      endpoint: `/appsettings/${appName}`,
    }
    const res = this.authenticatedRequest<any>(config)
    return res
  }

  public updateAppSetting(appName: string, update: {key: string; value: any}): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: `/appsettings/${appName}`,
      data: update,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(response => response.data)
  }

  public updateGlassesState(state: Partial<GlassesInfo>): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/client/device/state",
      data: state,
    }
    interface Response {
      success: boolean
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  public exchangeToken(token: string): AsyncResult<string, Error> {
    const isChina: string = useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)

    const config: RequestConfig = {
      method: "POST",
      endpoint: "/auth/exchange-token",
      data: {
        supabaseToken: !isChina ? token : undefined,
        authingToken: isChina ? token : undefined,
      },
    }
    interface Response {
      coreToken: string
    }
    let res = this.makeRequest<Response>(config)
    const coreTokenResult: AsyncResult<string, Error> = res.map(response => response.coreToken)

    // set the core token in the store:
    return coreTokenResult.and_then((coreToken: string) => {
      this.setCoreToken(coreToken)
      return Res.ok(coreToken)
    })
  }

  public generateWebviewToken(
    packageName: string,
    endpoint: string = "generate-webview-token",
  ): AsyncResult<string, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: `/api/auth/${endpoint}`,
      data: {packageName},
    }
    interface Response {
      token: string
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(response => response.token)
  }

  public hashWithApiKey(stringToHash: string, packageName: string): AsyncResult<string, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/auth/hash-with-api-key",
      data: {stringToHash, packageName},
    }
    interface Response {
      hash: string
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(response => response.hash)
  }

  // Account Management
  public requestAccountDeletion(): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/account/request-deletion",
    }
    interface Response {
      success: boolean
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  public confirmAccountDeletion(requestId: string, confirmationCode: string): AsyncResult<any, Error> {
    const config: RequestConfig = {
      method: "DELETE",
      endpoint: "/api/account/confirm-deletion",
      data: {requestId, confirmationCode},
    }
    interface Response {
      success: boolean
    }
    const res = this.authenticatedRequest<Response>(config)
    return res
  }

  public getLivekitUrlAndToken(): AsyncResult<{url: string; token: string}, Error> {
    const config: RequestConfig = {
      method: "GET",
      endpoint: "/api/client/livekit/token",
    }
    interface Response {
      // url: string
      // token: string
      success: boolean
      data: {url: string; token: string}
    }
    const res = this.authenticatedRequest<Response>(config)

    // ;(async () => {
    //   console.log("result@@@@@", await result)
    //   // const response = await Res.value
    //   // return {url: response.url, token: response.token}
    // })()

    return res.map(response => response.data)
  }

  // User Feedback & Settings
  public sendFeedback(feedbackBody: string): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/client/feedback",
      data: {feedback: feedbackBody},
    }
    interface Response {
      success: boolean
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  public writeUserSettings(settings: any): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/client/user/settings",
      data: {settings},
    }
    interface Response {
      success: boolean
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  public loadUserSettings(): AsyncResult<any, Error> {
    const config: RequestConfig = {
      method: "GET",
      endpoint: "/api/client/user/settings",
    }
    interface Response {
      success: boolean
      data: {settings: Record<string, any>}
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(response => response.data.settings)
  }

  // Error Reporting
  public sendErrorReport(reportData: any): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/app/error-report",
      data: reportData,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  // Calendar
  public sendCalendarData(data: any): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/client/calendar",
      data: data,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  // Location
  public sendLocationData(data: any): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/client/location",
      data: data,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  // Phone Notifications
  public sendPhoneNotification(data: {
    notificationId: string
    app: string
    title: string
    content: string
    priority: string
    timestamp: number
    packageName: string
  }): AsyncResult<any, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/client/notifications",
      data: data,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }

  public sendPhoneNotificationDismissed(data: {
    notificationId: string
    notificationKey: string
    packageName: string
  }): AsyncResult<any, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/client/notifications/dismissed",
      data: data,
    }
    interface Response {
      success: boolean
      data: any
    }
    const res = this.authenticatedRequest<Response>(config)
    return res.map(() => undefined)
  }
}

const restComms = RestComms.getInstance()
export default restComms
