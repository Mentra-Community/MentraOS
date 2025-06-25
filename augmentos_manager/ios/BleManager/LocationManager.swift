//
//  LocationManager.swift
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/16/25.
//

import Foundation
import CoreLocation

class LocationManager: NSObject, CLLocationManagerDelegate {
  private let locationManager = CLLocationManager()
  private var locationChangedCallback: (() -> Void)?
  private var currentLocation: CLLocation?
  
  override init() {
    super.init()
    // delay setup until after login:
    // setup()
  }
  
  public func setup() {
    locationManager.delegate = self
    locationManager.desiredAccuracy = kCLLocationAccuracyBest
    locationManager.distanceFilter = 2 // Update when user moves 2 meters
    locationManager.allowsBackgroundLocationUpdates = false
    locationManager.pausesLocationUpdatesAutomatically = true
    
    // No longer requesting authorization here - permissions are handled by React Native
    
    // Start location updates (will only work if permission is already granted)
    locationManager.startUpdatingLocation()

    // TEMPORARY TEST CODE
    self.setHighAccuracyMode(enabled: true)
    
  }
  
  // enables highest accuracy gps mode (higher battery consumption so we'll need to
  // disclose that in the SDK docs)
  // The distanceFilter can be changed for kCLLocationAccuracyBestForNavigation as well
  public func setHighAccuracyMode(enabled: Bool) {
    if enabled {
      print("LocationManager: Enabling high accuracy mode (Best for Navigation)")
      locationManager.allowsBackgroundLocationUpdates = true
      locationManager.pausesLocationUpdatesAutomatically = false
      locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
      locationManager.distanceFilter = kCLDistanceFilterNone
    } else {
      print("LocationManager: Disabling high accuracy mode, reverting to standard.")
      locationManager.allowsBackgroundLocationUpdates = false
      locationManager.pausesLocationUpdatesAutomatically = true
      locationManager.desiredAccuracy = kCLLocationAccuracyBest
      locationManager.distanceFilter = 2 // Default 2 meters
    }
  }
  
  func setLocationChangedCallback(_ callback: @escaping () -> Void) {
    self.locationChangedCallback = callback
  }
  
  // MARK: - CLLocationManagerDelegate Methods
  
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { return }
    
    // [MODIFIED FOR TESTING]
    // When in high accuracy mode, we want to log every single update regardless of distance.
    let isHighAccuracy = locationManager.desiredAccuracy == kCLLocationAccuracyBestForNavigation
    
    if isHighAccuracy || currentLocation == nil || location.distance(from: currentLocation!) > locationManager.distanceFilter {
      currentLocation = location

      print("LocationManager: Location updated to \(location.coordinate.latitude), \(location.coordinate.longitude)")
      
      // Notify via callback
      locationChangedCallback?()
    }
  }
  
  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    print("LocationManager: Failed to get location. Error: \(error.localizedDescription)")
  }
  
  func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
    switch status {
    case .authorizedWhenInUse, .authorizedAlways:
      locationManager.startUpdatingLocation()
    case .denied, .restricted:
      print("LocationManager: Location access denied or restricted")
    case .notDetermined:
      print("LocationManager: Location permission not determined yet")
    @unknown default:
      print("LocationManager: Unknown authorization status")
    }
  }
  
  // MARK: - Location Getters
  
  func getCurrentLocation() -> (latitude: Double, longitude: Double)? {
    guard let location = currentLocation else { return nil }
    return (latitude: location.coordinate.latitude, longitude: location.coordinate.longitude)
  }
  
  func getLastKnownLocation() -> (latitude: Double, longitude: Double)? {
    return getCurrentLocation()
  }
}
