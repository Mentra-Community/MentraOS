/**
 * @fileoverview Even Realities G2 Hardware Capabilities
 *
 * Capability profile for the Even Realities G2 smart glasses model.
 * G2 uses the EvenHub protocol with protobuf-based commands.
 */

import type { Capabilities } from "../hardware";

/**
 * Even Realities G2 capability profile
 */
export const evenRealitiesG2: Capabilities = {
  modelName: "Even Realities G2",

  // Camera capabilities - G2 does not have a camera
  hasCamera: false,
  camera: null,

  // Display capabilities - G2 has a green monochrome display (similar to G1)
  hasDisplay: true,
  display: {
    count: 2,
    isColor: false,
    color: "green",
    canDisplayBitmap: true,
    resolution: { width: 640, height: 200 },
    fieldOfView: { horizontal: 25 },
    maxTextLines: 5,
    adjustBrightness: true,
  },

  // Microphone capabilities - G2 has one microphone (right side), LC3 codec
  hasMicrophone: true,
  microphone: {
    count: 1,
    hasVAD: false,
  },

  // Speaker capabilities - G2 does not have a speaker
  hasSpeaker: false,
  speaker: null,

  // IMU capabilities - G2 has IMU
  hasIMU: true,
  imu: null,

  // Button capabilities - G2 has a capacitive touchbar
  hasButton: true,
  button: {
    count: 1,
    buttons: [{
      type: "swipe1d",
      events: ["TAP", "DOUBLE_TAP", "TRIPLE_TAP", "PRESS_HOLD", "SWIPE_UP", "SWIPE_DOWN"],
      isCapacitive: true,
    }],
  },

  // Light capabilities - G2 does not have lights
  hasLight: false,
  light: null,

  // Power capabilities
  power: {
    hasExternalBattery: false,
  },

  // WiFi capabilities - G2 does not support WiFi
  hasWifi: false,
};
