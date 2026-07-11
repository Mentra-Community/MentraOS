/**
 * @fileoverview Simulated Glasses Hardware Capabilities
 *
 * Capability profile for the Simulated Glasses model.
 * Defines the hardware and software features available on this device.
 * This profile matches the Vuzix Z100 capabilities for testing purposes.
 */

import type { Capabilities } from "../hardware";

/**
 * Simulated Glasses capability profile
 */
export const simulatedGlasses: Capabilities = {
  modelName: "Simulated Glasses",

  // Camera capabilities - does not have a camera
  hasCamera: false,
  camera: null,

  // Display capabilities - has a green monochrome display
  hasDisplay: true,
  display: {
    count: 1,
    isColor: false,
    color: "green",
    canDisplayBitmap: false,
    resolution: { width: 640, height: 480 },
    fieldOfView: { horizontal: 30 },
    maxTextLines: 7,
    adjustBrightness: true,
  },

  // Microphone capabilities - has a microphone (phone mic)
  hasMicrophone: true,
  microphone: {
    count: 1,
    hasVAD: false,
  },

  // Speaker capabilities - has a speaker (phone speaker)
  hasSpeaker: true,
  speaker: {
    count: 1,
    isPrivate: false,
  },

  // IMU capabilities - does not have an IMU
  hasIMU: false,
  imu: null,

  // Button capabilities - Has one simulated button
  hasButton: true,
  button: {
    count: 1,
    buttons: [
      {
        type: "press",
        events: ["press"],
        isCapacitive: false,
      },
    ],
  },

  // Light capabilities - does not have lights
  hasLight: false,
  light: null,

  // Power capabilities - does not have external battery
  power: {
    hasExternalBattery: false,
  },

  // WiFi capabilities - does not support WiFi
  hasWifi: false,
};
