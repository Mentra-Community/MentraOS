import axios, {AxiosInstance, AxiosRequestConfig} from "axios"
import {AsyncResult, Result, result as Res} from "typesafe-ts"

import {SETTINGS, useSettingsStore} from "../stores/settings"
import {useConnectionStore} from "../stores/connection"
import {WebSocketStatus} from "../stores/connection"
import GlobalEventEmitter from "../utils/GlobalEventEmitter"
import {BgTimer} from "../utils/timers"

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
    const tokenLen = token?.length ?? 0
    // Log presence/length only — never token bytes (they'd end up in log pipelines).
    console.log(`${this.TAG}: Core token ${token ? "set" : "cleared"} - Length: ${tokenLen}`)

    // This is the legacy Cloud V1 token. Cloud V2 glasses/report auth is synced
    // by CloudClientService so V1 cannot overwrite the native Bluetooth slot.

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
    // console.log(`REST: ${method}:${url}`)

    const headers = requiresAuth ? this.createAuthHeaders() : {"Content-Type": "application/json"}

    const axiosConfig: AxiosRequestConfig = {
      method,
      url,
      headers,
      data,
      params,
    }

    return Res.try_async(async () => {
      try {
        const res = await this.axiosInstance.request<T>(axiosConfig)
        return res.data
      } catch (error) {
        if (!this.isNoActiveSessionError(error)) {
          throw error
        }

        // Cloud pod has no session for this user (we reconnected to a different
        // pod, or the prior session was cleaned up). Trigger a WS reconnect,
        // wait for it to land, then retry the request exactly once.
        //
        // Subscribe BEFORE emitting so we don't miss the DISCONNECTED → CONNECTED
        // transition triggered by handleNoActiveSession → reconnectNow.
        const waitPromise = this.waitForNextConnected(8_000)
        GlobalEventEmitter.emit("NO_ACTIVE_SESSION")
        try {
          await waitPromise
        } catch (waitErr) {
          console.log(`${this.TAG}: Retry skipped — WS didn't reconnect in time:`, waitErr)
          throw error
        }

        const retryHeaders = requiresAuth ? this.createAuthHeaders() : {"Content-Type": "application/json"}
        const retryRes = await this.axiosInstance.request<T>({...axiosConfig, headers: retryHeaders})
        return retryRes.data
      }
    })
  }

  /**
   * Resolves on the NEXT CONNECTED transition of the WS (or rejects after
   * timeoutMs). Does NOT short-circuit when already CONNECTED — callers
   * invoke this after a 503 NO_ACTIVE_SESSION when we know the current
   * connection is landing on the wrong pod; we need to wait for the
   * post-reconnect CONNECTED event, not the current one.
   *
   * Uses the connection store directly rather than WebSocketManager to avoid
   * a circular import (WebSocketManager → RestComms → WebSocketManager).
   */
  private waitForNextConnected(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = BgTimer.setTimeout(() => {
        if (settled) return
        settled = true
        unsub()
        reject(new Error(`waitForNextConnected timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      let sawNonConnected = useConnectionStore.getState().status !== WebSocketStatus.CONNECTED
      const unsub = useConnectionStore.subscribe((state) => {
        if (settled) return
        if (state.status !== WebSocketStatus.CONNECTED) {
          sawNonConnected = true
          return
        }
        // Only resolve on a CONNECTED transition that follows a non-CONNECTED
        // state. This guarantees we waited for a real reconnect rather than
        // resolving on the stale pre-reconnect CONNECTED state.
        if (sawNonConnected) {
          settled = true
          BgTimer.clearTimeout(timer)
          unsub()
          resolve()
        }
      })
    })
  }

  private isNoActiveSessionError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false
    }

    return error.response?.status === 503 && error.response?.data?.error === "NO_ACTIVE_SESSION"
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
    return res.map((response) => response.data)
  }

  public retry<T>(fn: () => AsyncResult<T, Error>, attempts: number, delayMs: number = 0): AsyncResult<T, Error> {
    return Res.try_async(async () => {
      let lastError: Error | null = null

      for (let i = 0; i < attempts; i++) {
        const result: Result<T, Error> = await fn()
        if (result.is_ok()) {
          return result.value
        }
        lastError = result.error
        if (i < attempts - 1 && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
      throw lastError
    })
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
    const coreTokenResult: AsyncResult<string, Error> = res.map((response) => response.coreToken)

    // set the core token in the store:
    return coreTokenResult.and_then((coreToken: string) => {
      this.setCoreToken(coreToken)
      return Res.ok(coreToken)
    })
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
    return res.map((response) => response.data.settings)
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

  public goodbye(): AsyncResult<void, Error> {
    const config: RequestConfig = {
      method: "POST",
      endpoint: "/api/client/goodbye",
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
