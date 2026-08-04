import CoreLocation
import Foundation
import MapboxDirections

// Maps the Mapbox Directions maneuver (type + direction) to the string values
// the JS layer expects — the SAME vocabulary the Android Mapbox migration
// emits via NavigationManager.kt `mapManeuver()`, which is in turn the same
// vocabulary the old Google iOS path produced. The miniapp SDK's
// `ManeuverKind` is frozen, so these strings must not change.
//
// Mapbox Directions splits a maneuver into:
//   • ManeuverType      — depart / turn / fork / merge / arrive / continue / …
//   • ManeuverDirection — left / right / slightLeft / slightRight / sharpLeft /
//                          sharpRight / straight / uTurn
// We combine them the way Android does (type drives the verb; direction
// drives left/right + slight/sharp variants).
//
// VERIFY-IN-XCODE: enum case spellings (`.turn`, `.slightLeft`, etc.) are from
// MapboxDirections v3. Confirm against the installed SDK if the compiler
// flags any case name.
func maneuverString(type: ManeuverType?, direction: ManeuverDirection?) -> String {
  switch type {
  case .some(.arrive):
    return "ARRIVE"
  case .some(.depart):
    return "DEPART"
  case .some(.reachFork), .some(.merge), .some(.takeOnRamp), .some(.takeOffRamp):
    // Forks / merges / ramps map to the SLIGHT variant of their side.
    switch direction {
    case .some(.left), .some(.slightLeft), .some(.sharpLeft):
      return "SLIGHT_LEFT"
    case .some(.right), .some(.slightRight), .some(.sharpRight):
      return "SLIGHT_RIGHT"
    default:
      return "STRAIGHT"
    }
  default:
    // turn / continue / endOfRoad / roundabout / rotary / unknown — direction
    // drives the left/right + slight/sharp/u-turn family.
    return directionString(direction)
  }
}

/// Map a ManeuverDirection to the left/right family used by the JS layer.
private func directionString(_ direction: ManeuverDirection?) -> String {
  switch direction {
  case .some(.left): return "TURN_LEFT"
  case .some(.right): return "TURN_RIGHT"
  case .some(.slightLeft): return "SLIGHT_LEFT"
  case .some(.slightRight): return "SLIGHT_RIGHT"
  case .some(.sharpLeft): return "SHARP_LEFT"
  case .some(.sharpRight): return "SHARP_RIGHT"
  case .some(.uTurn): return "U_TURN"
  default: return "STRAIGHT"
  }
}

/// Convert a list of route coordinates to the `[{lat,lng}]` array the JS bridge
/// expects (matching Android's RoutePoint shape).
func coordinatesToPoints(_ coords: [CLLocationCoordinate2D]) -> [[String: Double]] {
  coords.map { ["lat": $0.latitude, "lng": $0.longitude] }
}
