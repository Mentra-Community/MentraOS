/**
 * API Client
 *
 * HTTP client for communicating with Mentra cloud API
 */

import axios, {AxiosInstance, AxiosError} from "axios"
import {loadCredentials} from "../config/credentials"
import {getApiUrl} from "../config/clouds"

export class APIClient {
  private client: AxiosInstance

  constructor() {
    this.client = axios.create({
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    })

    // Add request interceptor to set baseURL and auth dynamically
    this.client.interceptors.request.use(async (config) => {
      // Set baseURL from current cloud
      config.baseURL = getApiUrl()

      // Add auth header if credentials exist
      const creds = await loadCredentials()
      if (creds?.token) {
        config.headers.Authorization = `Bearer ${creds.token}`
      }

      return config
    })

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response?.status === 401) {
          console.error("✗ Authentication failed")
          console.error("  Your CLI API key may be invalid or revoked")
          console.error("  Generate a new key in the console")
          process.exit(3)
        }
        throw error
      },
    )
  }

  // Apps
  async listApps(orgId?: string) {
    const params = orgId ? {orgId} : undefined
    const res = await this.client.get("/api/cli/apps", {params})
    return res.data?.data ?? res.data
  }

  async createApp(data: any) {
    const res = await this.client.post("/api/cli/apps", data)
    return res.data?.data ?? res.data
  }

  async getApp(packageName: string) {
    const res = await this.client.get(`/api/cli/apps/${encodeURIComponent(packageName)}`)
    return res.data?.data ?? res.data
  }

  async updateApp(packageName: string, data: any) {
    const res = await this.client.put(`/api/cli/apps/${encodeURIComponent(packageName)}`, data)
    return res.data?.data ?? res.data
  }

  async deleteApp(packageName: string) {
    const res = await this.client.delete(`/api/cli/apps/${encodeURIComponent(packageName)}`)
    return res.data?.data ?? res.data
  }

  async publishApp(packageName: string) {
    const res = await this.client.post(`/api/cli/apps/${encodeURIComponent(packageName)}/publish`)
    return res.data?.data ?? res.data
  }

  async regenerateApiKey(packageName: string) {
    const res = await this.client.post(`/api/cli/apps/${encodeURIComponent(packageName)}/api-key`)
    return res.data?.data ?? res.data
  }

  // Organizations
  async listOrgs() {
    const res = await this.client.get("/api/cli/orgs")
    return res.data?.data ?? res.data
  }

  async getOrg(orgId: string) {
    const res = await this.client.get(`/api/cli/orgs/${orgId}`)
    return res.data?.data ?? res.data
  }
}

// Singleton instance
export const api = new APIClient()
