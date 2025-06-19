// This file serves as a platform-independent interface for CoreCommunicator
// We explicitly import the correct platform-specific implementation

import {Platform} from "react-native"
import {CoreCommunicator as AndroidCommunicator} from "./CoreCommunicator.android"
import {CoreCommunicator as IOSCommunicator} from "./CoreCommunicator.ios"

// Declare type for the communicator instance
type CommunicatorType = AndroidCommunicator | IOSCommunicator

// Import based on platform
let coreCommunicator: CommunicatorType
if (Platform.OS === "ios") {
  coreCommunicator = require("./CoreCommunicator.ios").default
} else {
  coreCommunicator = require("./CoreCommunicator.android").default
}

export default coreCommunicator
