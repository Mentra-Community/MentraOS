import GoogleNavigation

// Maps the SDK's GMSNavigationManeuver enum to the string values
// the JS layer expects (matching Android's NavInfoReceiverService mapping).
func maneuverString(_ maneuver: GMSNavigationManeuver) -> String {
  switch maneuver {
  case .turnLeft, .turnKeepLeft: return "TURN_LEFT"
  case .turnRight, .turnKeepRight: return "TURN_RIGHT"
  case .turnSlightLeft: return "SLIGHT_LEFT"
  case .turnSlightRight: return "SLIGHT_RIGHT"
  case .turnSharpLeft: return "SHARP_LEFT"
  case .turnSharpRight: return "SHARP_RIGHT"
  case .turnUTurnClockwise, .turnUTurnCounterClockwise: return "U_TURN"
  case .destination, .destinationLeft, .destinationRight: return "ARRIVE"
  case .mergeUnspecified, .mergeLeft, .mergeRight: return "STRAIGHT"
  case .forkLeft, .onRampLeft, .onRampSlightLeft, .onRampSharpLeft, .offRampLeft, .offRampSlightLeft, .offRampSharpLeft: return "SLIGHT_LEFT"
  case .forkRight, .onRampRight, .onRampSlightRight, .onRampSharpRight, .offRampRight, .offRampSlightRight, .offRampSharpRight: return "SLIGHT_RIGHT"
  case .ferryBoat, .ferryTrain: return "STRAIGHT"
  case .roundaboutSharpLeftClockwise, .roundaboutSharpLeftCounterClockwise,
       .roundaboutLeftClockwise, .roundaboutLeftCounterClockwise,
       .roundaboutSlightLeftClockwise, .roundaboutSlightLeftCounterClockwise: return "TURN_LEFT"
  case .roundaboutSharpRightClockwise, .roundaboutSharpRightCounterClockwise,
       .roundaboutRightClockwise, .roundaboutRightCounterClockwise,
       .roundaboutSlightRightClockwise, .roundaboutSlightRightCounterClockwise: return "TURN_RIGHT"
  case .roundaboutStraightClockwise, .roundaboutStraightCounterClockwise,
       .roundaboutClockwise, .roundaboutCounterClockwise,
       .roundaboutExitClockwise, .roundaboutExitCounterClockwise: return "STRAIGHT"
  case .straight: return "STRAIGHT"
  default: return "STRAIGHT"
  }
}

// Converts a GMSPath to the [[lat, lng]] array the JS bridge expects.
func pathToPoints(_ path: GMSPath) -> [[String: Double]] {
  var points: [[String: Double]] = []
  for i in 0..<path.count() {
    let coord = path.coordinate(at: i)
    points.append(["lat": coord.latitude, "lng": coord.longitude])
  }
  return points
}
