/**
 * @fileoverview Mentra Display Hardware Capabilities
 *
 * Capability profile for the Mentra Display smart glasses model.
 * Defines the hardware and software features available on this device.
 */

import type { Capabilities } from "../hardware";

/**
 * Mentra Display capability profile
 */
export const mentraDisplay: Capabilities = {
  modelName: "Mentra Display",

  // Camera capabilities - Mentra Display does not have a camera
  hasCamera: false,
  camera: null,

  // Display capabilities - Mentra Display has a green monochrome display
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

  // Microphone capabilities - Mentra Display has one microphone without VAD
  hasMicrophone: true,
  microphone: {
    count: 1,
    hasVAD: false,
  },

  // Speaker capabilities - Mentra Display does not have a speaker
  hasSpeaker: false,
  speaker: null,

  // IMU capabilities - Mentra Display has IMU for head-up/down detection but raw data not exposed to apps
  hasIMU: true,
  imu: null,

  // Button capabilities - Mentra Display does not have buttons
  hasButton: false,
  button: null,

  // Light capabilities - Mentra Display does not have lights
  hasLight: false,
  light: null,

  // Power capabilities - Mentra Display does not have external battery
  power: {
    hasExternalBattery: false,
  },

  // WiFi capabilities - Mentra Display does not support WiFi
  hasWifi: false,
};
