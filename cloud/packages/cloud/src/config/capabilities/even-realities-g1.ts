/**
 * @fileoverview Even Realities G1 Hardware Capabilities
 *
 * Capability profile for the Even Realities G1 smart glasses model.
 * Defines the hardware and software features available on this device.
 */

import type { Capabilities } from "@mentra/sdk";

/**
 * Even Realities G1 capability profile
 */
export const evenRealitiesG1: Capabilities = {
  modelName: "Even Realities G1",

  // Camera capabilities - G1 does not have a camera
  hasCamera: false,
  camera: null,

  // Display capabilities - G1 has a green monochrome display
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

  // Microphone capabilities - G1 has one microphone without VAD
  hasMicrophone: true,
  microphone: {
    count: 1,
    hasVAD: false,
  },

  // Speaker capabilities - G1 does not have a speaker
  hasSpeaker: false,
  speaker: null,

  // IMU capabilities - G1 has IMU for head-up/down detection but raw data not exposed to apps
  hasIMU: true,
  imu: null,

  // Button capabilities - G1 does not have buttons
  hasButton: false,
  button: null,

  // Light capabilities - G1 does not have lights
  hasLight: false,
  light: null,

  // Power capabilities - G1 does not have external battery
  power: {
    hasExternalBattery: false,
  },

  // WiFi capabilities - G1 does not support WiFi
  hasWifi: false,
};
