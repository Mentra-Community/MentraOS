/**
 * LocationManager
 *
 * Simple wrapper around expo-location for fetching the user's GPS coordinates.
 * Use getCurrentPosition() for a single fix or getLastKnownPosition() for the
 * cached fix (faster, may be slightly stale).
 *
 * Permissions are requested on first use; callers can also call
 * requestPermission() up-front during onboarding.
 */

import * as Location from "expo-location"

const LOG_TAG = "LOCATION_MANAGER"

export type Coords = {
  latitude: number
  longitude: number
  accuracy: number | null
  timestamp: number
}

type LocationListener = (coords: Coords) => void

class LocationManager {
  private static instance: LocationManager | null = null
  private permissionGranted = false
  private watchSubscription: Location.LocationSubscription | null = null
  private listeners = new Set<LocationListener>()

  private constructor() {}

  public static getInstance(): LocationManager {
    if (!LocationManager.instance) {
      LocationManager.instance = new LocationManager()
    }
    return LocationManager.instance
  }

  public async requestPermission(): Promise<boolean> {
    const {status} = await Location.requestForegroundPermissionsAsync()
    this.permissionGranted = status === "granted"
    console.log(`${LOG_TAG}: permission status=${status}`)
    return this.permissionGranted
  }

  private async ensurePermission(): Promise<boolean> {
    if (this.permissionGranted) return true
    return this.requestPermission()
  }

  /**
   * Get a fresh GPS fix. Slower than getLastKnownPosition() but current.
   */
  public async getCurrentPosition(accuracy: Location.Accuracy = Location.Accuracy.Balanced): Promise<Coords | null> {
    if (!(await this.ensurePermission())) {
      console.warn(`${LOG_TAG}: permission denied`)
      return null
    }

    try {
      const loc = await Location.getCurrentPositionAsync({accuracy})
      return {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        accuracy: loc.coords.accuracy,
        timestamp: loc.timestamp,
      }
    } catch (err) {
      console.error(`${LOG_TAG}: getCurrentPosition failed`, err)
      return null
    }
  }

  /**
   * Get the OS-cached last known position. Returns immediately, may be stale
   * or null if no fix has ever been taken.
   */
  public async getLastKnownPosition(): Promise<Coords | null> {
    if (!(await this.ensurePermission())) {
      console.warn(`${LOG_TAG}: permission denied`)
      return null
    }

    try {
      const loc = await Location.getLastKnownPositionAsync()
      if (!loc) return null
      return {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        accuracy: loc.coords.accuracy,
        timestamp: loc.timestamp,
      }
    } catch (err) {
      console.error(`${LOG_TAG}: getLastKnownPosition failed`, err)
      return null
    }
  }

  /**
   * Subscribe to continuous foreground location updates. Returns an unsubscribe
   * function. The underlying watcher is started on first subscription and
   * stopped when the last listener unsubscribes.
   *
   * Updates only fire while the app is in the foreground. For background
   * tracking, use expo-location's TaskManager API (see MantleManager).
   */
  public addListener(
    listener: LocationListener,
    opts: {accuracy?: Location.Accuracy; distanceInterval?: number; timeInterval?: number} = {},
  ): () => void {
    this.listeners.add(listener)
    if (!this.watchSubscription) {
      this.startWatching(opts).catch((err) => {
        console.error(`${LOG_TAG}: startWatching failed`, err)
      })
    }
    return () => this.removeListener(listener)
  }

  private removeListener(listener: LocationListener): void {
    this.listeners.delete(listener)
    if (this.listeners.size === 0 && this.watchSubscription) {
      this.watchSubscription.remove()
      this.watchSubscription = null
      console.log(`${LOG_TAG}: stopped watching (no listeners)`)
    }
  }

  private async startWatching(opts: {
    accuracy?: Location.Accuracy
    distanceInterval?: number
    timeInterval?: number
  }): Promise<void> {
    if (!(await this.ensurePermission())) {
      console.warn(`${LOG_TAG}: cannot watch — permission denied`)
      return
    }
    this.watchSubscription = await Location.watchPositionAsync(
      {
        accuracy: opts.accuracy ?? Location.Accuracy.Balanced,
        distanceInterval: opts.distanceInterval ?? 0,
        timeInterval: opts.timeInterval ?? 1000,
      },
      (loc) => {
        const coords: Coords = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          accuracy: loc.coords.accuracy,
          timestamp: loc.timestamp,
        }
        this.listeners.forEach((l) => {
          try {
            l(coords)
          } catch (err) {
            console.error(`${LOG_TAG}: listener threw`, err)
          }
        })
      },
    )
    console.log(`${LOG_TAG}: started watching`)
  }

  public cleanup(): void {
    console.log(`${LOG_TAG}: cleanup()`)
    if (this.watchSubscription) {
      this.watchSubscription.remove()
      this.watchSubscription = null
    }
    this.listeners.clear()
    this.permissionGranted = false
    LocationManager.instance = null
  }
}

const locationManager = LocationManager.getInstance()
export default locationManager
