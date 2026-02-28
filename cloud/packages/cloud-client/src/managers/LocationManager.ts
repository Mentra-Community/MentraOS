/**
 * LocationManager - Handles GPS and location updates
 */

import { EventEmitter } from "events";
import type { BehaviorConfig } from "../types";

export class LocationManager extends EventEmitter {
  private config: BehaviorConfig;
  private currentLocation: { lat: number; lng: number } | null = null;
  private updateInterval: NodeJS.Timer | null = null;
  private isRunning = false;

  constructor(config: BehaviorConfig) {
    super();
    this.config = config;
  }

  /**
   * Start automatic location updates (if enabled)
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;

    // Start periodic location updates if we have a current location
    if (this.currentLocation && (this.config.locationUpdateInterval ?? 0) > 0) {
      this.updateInterval = setInterval(() => {
        if (this.currentLocation) {
          this.emit(
            "location_update",
            this.currentLocation.lat,
            this.currentLocation.lng,
          );
        }
      }, this.config.locationUpdateInterval ?? 5000);
    }
  }

  /**
   * Stop automatic location updates
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Update current location
   */
  updateLocation(lat: number, lng: number): void {
    const previousLocation = this.currentLocation;
    this.currentLocation = { lat, lng };

    // If this is the first location and we're running, start periodic updates
    if (
      !previousLocation &&
      this.isRunning &&
      (this.config.locationUpdateInterval ?? 0) > 0
    ) {
      this.start(); // Restart to set up interval
    }

    // Emit immediate location update
    this.emit("location_update", lat, lng);
  }

  /**
   * Get current location
   */
  getCurrentLocation(): { lat: number; lng: number } | null {
    return this.currentLocation ? { ...this.currentLocation } : null;
  }

  /**
   * Calculate distance between two points (in meters)
   */
  static calculateDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * Check if location has moved significantly since last update
   */
  hasMovedSignificantly(
    lat: number,
    lng: number,
    thresholdMeters = 10,
  ): boolean {
    if (!this.currentLocation) return true;

    const distance = LocationManager.calculateDistance(
      this.currentLocation.lat,
      this.currentLocation.lng,
      lat,
      lng,
    );

    return distance >= thresholdMeters;
  }

  /**
   * Simulate movement along a route
   */
  simulateMovement(
    waypoints: Array<{ lat: number; lng: number }>,
    speedKmh = 5, // Walking speed
    updateIntervalMs = 1000,
  ): void {
    if (waypoints.length < 2) return;

    let currentWaypointIndex = 0;
    let currentWaypoint = waypoints[0];
    let nextWaypoint = waypoints[1];
    let progress = 0;

    this.updateLocation(currentWaypoint.lat, currentWaypoint.lng);

    const simulationInterval = setInterval(() => {
      // Calculate how far we should move this step
      const speedMs = (speedKmh * 1000) / (60 * 60); // Convert km/h to m/s
      const distanceThisStep = speedMs * (updateIntervalMs / 1000);

      // Calculate total distance to next waypoint
      const totalDistance = LocationManager.calculateDistance(
        currentWaypoint.lat,
        currentWaypoint.lng,
        nextWaypoint.lat,
        nextWaypoint.lng,
      );

      // Update progress
      progress += distanceThisStep / totalDistance;

      if (progress >= 1) {
        // Reached waypoint, move to next
        currentWaypointIndex++;
        if (currentWaypointIndex >= waypoints.length - 1) {
          // Reached destination
          this.updateLocation(
            waypoints[waypoints.length - 1].lat,
            waypoints[waypoints.length - 1].lng,
          );
          clearInterval(simulationInterval);
          return;
        }

        currentWaypoint = waypoints[currentWaypointIndex];
        nextWaypoint = waypoints[currentWaypointIndex + 1];
        progress = 0;
      }

      // Interpolate position between waypoints
      const lat =
        currentWaypoint.lat +
        (nextWaypoint.lat - currentWaypoint.lat) * progress;
      const lng =
        currentWaypoint.lng +
        (nextWaypoint.lng - currentWaypoint.lng) * progress;

      this.updateLocation(lat, lng);
    }, updateIntervalMs);
  }
}
