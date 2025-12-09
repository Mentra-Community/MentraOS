/**
 * Network Connectivity Service
 * Monitors network changes and verifies connectivity to Mentra Live glasses
 */

import NetInfo, {NetInfoState, NetInfoSubscription} from "@react-native-community/netinfo"
import WifiManager from "react-native-wifi-reborn"

import {asgCameraApi} from "./asgCameraApi"

export interface NetworkStatus {
  phoneConnected: boolean
  phoneSSID: string | null
  glassesConnected: boolean
  glassesSSID: string | null
  galleryReachable: boolean
  lastCheckTime: number
  isHotspot: boolean
}

type NetworkChangeCallback = (status: NetworkStatus) => void

class NetworkConnectivityService {
  private listeners: Set<NetworkChangeCallback> = new Set()
  private netInfoSubscription: NetInfoSubscription | null = null
  private currentStatus: NetworkStatus = {
    phoneConnected: false,
    phoneSSID: null,
    glassesConnected: false,
    glassesSSID: null,
    galleryReachable: false,
    lastCheckTime: 0,
    isHotspot: false,
  }
  private checkInProgress = false
  private glassesIp: string | null = null

  /**
   * Initialize the service and start monitoring
   */
  initialize() {
    console.log("[NetworkConnectivity] Initializing service")

    // Subscribe to network state changes
    this.netInfoSubscription = NetInfo.addEventListener(this.handleNetworkChange)

    // Do an initial check
    this.checkConnectivity()
  }

  /**
   * Clean up subscriptions
   */
  destroy() {
    console.log("[NetworkConnectivity] Destroying service")
    if (this.netInfoSubscription) {
      this.netInfoSubscription()
      this.netInfoSubscription = null
    }
    this.listeners.clear()
  }

  /**
   * Handle network state changes from the phone
   */
  private handleNetworkChange = async (state: NetInfoState) => {
    console.log("[NetworkConnectivity] Phone network changed:", {
      type: state.type,
      isConnected: state.isConnected,
      isWifiEnabled: state.isWifiEnabled,
      details: state.details,
    })

    const prevStatus = {...this.currentStatus}

    // Update phone network status
    this.currentStatus.phoneConnected = state.isConnected || false

    // Extract SSID if on WiFi
    if (state.type === "wifi" && state.isConnected) {
      // Try to get SSID using WifiManager for iOS
      try {
        const ssid = await WifiManager.getCurrentWifiSSID()
        console.log("[NetworkConnectivity] Got WiFi SSID from WifiManager:", ssid)
        this.currentStatus.phoneSSID = ssid || null
      } catch (error) {
        console.log("[NetworkConnectivity] Failed to get WiFi SSID:", error)
        // Fallback to NetInfo details if available
        const wifiDetails = state.details as any
        this.currentStatus.phoneSSID = wifiDetails?.ssid || null
      }
      this.currentStatus.isHotspot = false
    } else if (state.type === "cellular" && state.isConnected) {
      // Phone is on cellular - might be hotspot if glasses are connected
      this.currentStatus.phoneSSID = null
      // We'll determine hotspot status when checking glasses
    } else {
      this.currentStatus.phoneSSID = null
      this.currentStatus.isHotspot = false
    }

    // If network changed, check gallery connectivity
    if (
      prevStatus.phoneConnected !== this.currentStatus.phoneConnected ||
      prevStatus.phoneSSID !== this.currentStatus.phoneSSID
    ) {
      console.log("[NetworkConnectivity] Network changed, checking gallery connectivity")
      this.checkGalleryConnectivity() // Disabled - only check when gallery is open
    }
  }

  /**
   * Update glasses WiFi status from status object
   */
  updateGlassesStatus(wifiConnected: boolean, wifiSSID: string | null, glassesIp?: string) {
    console.log("[NetworkConnectivity] Updating glasses status:", {
      wifiConnected,
      wifiSSID,
      glassesIp,
    })

    const prevStatus = {...this.currentStatus}

    this.currentStatus.glassesConnected = wifiConnected
    this.currentStatus.glassesSSID = wifiSSID

    if (glassesIp && glassesIp !== this.glassesIp) {
      const oldIp = this.glassesIp
      this.glassesIp = glassesIp
      // Update the camera API with the new IP
      asgCameraApi.setServer(glassesIp, 8089)
      console.log("[NetworkConnectivity] Updated glasses IP from", oldIp, "to:", glassesIp)
    } else if (!glassesIp && this.glassesIp) {
      console.log("[NetworkConnectivity] WARNING: Glasses IP cleared (was:", this.glassesIp, ")")
    } else if (!glassesIp) {
      console.log("[NetworkConnectivity] No glasses IP provided and none stored")
    }

    // Check if this might be a hotspot scenario
    if (
      !this.currentStatus.phoneSSID && // Phone not on WiFi
      this.currentStatus.phoneConnected && // Phone has internet
      this.currentStatus.glassesConnected && // Glasses on WiFi
      this.currentStatus.glassesSSID
    ) {
      // Check if glasses SSID looks like a phone hotspot
      const ssid = this.currentStatus.glassesSSID.toLowerCase()
      if (
        ssid.includes("iphone") ||
        ssid.includes("android") ||
        ssid.includes("phone") ||
        ssid.includes("hotspot") ||
        ssid.includes("mobile")
      ) {
        this.currentStatus.isHotspot = true
        console.log("[NetworkConnectivity] Detected hotspot connection")
      }
    }

    // If glasses status changed, check gallery connectivity
    if (
      prevStatus.glassesConnected !== this.currentStatus.glassesConnected ||
      prevStatus.glassesSSID !== this.currentStatus.glassesSSID
    ) {
      console.log("[NetworkConnectivity] Glasses status changed, checking gallery connectivity")
      this.checkGalleryConnectivity() // Disabled - only check when gallery is open
    }
  }

  /**
   * Check if gallery is reachable
   */
  private async checkGalleryConnectivity() {
    // Prevent multiple simultaneous checks
    if (this.checkInProgress) {
      console.log("[NetworkConnectivity] Check already in progress, skipping")
      return
    }

    this.checkInProgress = true

    try {
      // Mark as unreachable if glasses are not connected OR we don't have an IP
      if (!this.currentStatus.glassesConnected) {
        console.log("[NetworkConnectivity] Glasses not connected to WiFi, marking unreachable")
        this.currentStatus.galleryReachable = false
        this.currentStatus.lastCheckTime = Date.now()
        this.notifyListeners()
        return
      }

      if (!this.glassesIp) {
        console.log("[NetworkConnectivity] No glasses IP available, marking unreachable")
        // Even if glasses claim to be connected, without IP we can't reach them
        this.currentStatus.galleryReachable = false
        this.currentStatus.lastCheckTime = Date.now()
        this.notifyListeners()
        return
      }

      console.log("[NetworkConnectivity] Checking gallery reachability at:", this.glassesIp)
      const healthUrl = `http://${this.glassesIp}:8089/api/health`
      console.log("[NetworkConnectivity] Health check URL:", healthUrl)

      // Try to reach the health endpoint with a short timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000) // 3 second timeout

      try {
        console.log("[NetworkConnectivity] Starting GET request to health endpoint...")
        const response = await fetch(healthUrl, {
          method: "GET", // Changed from HEAD to GET
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "User-Agent": "MentraOS-Mobile/1.0",
          },
        })

        clearTimeout(timeoutId)

        this.currentStatus.galleryReachable = response.ok
        console.log("[NetworkConnectivity] Gallery reachability check completed:", {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
        })
      } catch (error) {
        clearTimeout(timeoutId)
        console.log("[NetworkConnectivity] Gallery not reachable:", error)
        this.currentStatus.galleryReachable = false
      }

      this.currentStatus.lastCheckTime = Date.now()
      this.notifyListeners()
    } finally {
      this.checkInProgress = false
    }
  }

  /**
   * Perform a full connectivity check
   */
  async checkConnectivity(): Promise<NetworkStatus> {
    console.log("[NetworkConnectivity] Performing full connectivity check")
    console.log("[NetworkConnectivity] Current state before check:", {
      glassesIp: this.glassesIp,
      glassesConnected: this.currentStatus.glassesConnected,
      glassesSSID: this.currentStatus.glassesSSID,
      phoneConnected: this.currentStatus.phoneConnected,
      phoneSSID: this.currentStatus.phoneSSID,
      galleryReachable: this.currentStatus.galleryReachable,
      lastCheckTime: this.currentStatus.lastCheckTime
        ? new Date(this.currentStatus.lastCheckTime).toISOString()
        : "never",
    })

    // Get current phone network state
    const netState = await NetInfo.fetch()
    this.handleNetworkChange(netState)

    // Check gallery if we have glasses info
    await this.checkGalleryConnectivity()

    console.log("[NetworkConnectivity] Check complete. New state:", {
      galleryReachable: this.currentStatus.galleryReachable,
      shouldShowWarning: this.shouldShowWarning(),
    })

    return this.currentStatus
  }

  /**
   * Get current network status
   */
  getStatus(): NetworkStatus {
    return {...this.currentStatus}
  }

  /**
   * Check if we should show a network warning
   */
  shouldShowWarning(): boolean {
    // Don't warn if glasses aren't connected at all
    if (!this.currentStatus.glassesConnected) {
      return false
    }

    // Don't warn if it's a hotspot connection
    if (this.currentStatus.isHotspot) {
      return false
    }

    // Don't warn if gallery is reachable
    if (this.currentStatus.galleryReachable) {
      return false
    }

    // Show warning if glasses are connected but gallery isn't reachable
    return true
  }

  /**
   * Get a user-friendly message about the network status
   */
  getStatusMessage(): string {
    if (!this.currentStatus.glassesConnected) {
      return "Glasses not connected to WiFi"
    }

    // Check if we have glasses IP
    if (this.currentStatus.glassesConnected && !this.glassesIp) {
      return "Cannot connect to glasses"
    }

    if (this.currentStatus.isHotspot) {
      if (this.currentStatus.galleryReachable) {
        return "Connected via hotspot"
      } else {
        return "Hotspot connection issue"
      }
    }

    if (!this.currentStatus.phoneConnected) {
      return "Phone not connected to network"
    }

    if (this.currentStatus.galleryReachable) {
      return "Gallery is accessible"
    }

    if (this.currentStatus.phoneSSID && this.currentStatus.glassesSSID) {
      if (this.currentStatus.phoneSSID !== this.currentStatus.glassesSSID) {
        return "Different WiFi networks"
      }
    }

    return "Cannot connect to glasses"
  }

  /**
   * Subscribe to network status changes
   */
  subscribe(callback: NetworkChangeCallback): () => void {
    this.listeners.add(callback)

    // Return unsubscribe function
    return () => {
      this.listeners.delete(callback)
    }
  }

  /**
   * Notify all listeners of status change
   */
  private notifyListeners() {
    const status = this.getStatus()
    this.listeners.forEach(listener => {
      try {
        listener(status)
      } catch (error) {
        console.error("[NetworkConnectivity] Error in listener:", error)
      }
    })
  }
}

// Export singleton instance
export const networkConnectivityService = new NetworkConnectivityService()
