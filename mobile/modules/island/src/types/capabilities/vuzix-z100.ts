/**
 * @fileoverview Vuzix Z100 Hardware Capabilities
 *
 * Capability profile for the Vuzix Z100 smart glasses model.
 * Defines the hardware and software features available on this device.
 */

import type { Capabilities } from "../hardware";

/**
 * Vuzix Z100 capability profile
 */
export const vuzixZ100: Capabilities = {
  modelName: "Vuzix Z100",

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

  // Microphone capabilities - does not have a microphone
  hasMicrophone: false,
  microphone: null,

  // Speaker capabilities - does not have a speaker
  hasSpeaker: false,
  speaker: null,

  // IMU capabilities - does not have an IMU
  hasIMU: false,
  imu: null,

  // Button capabilities - does not have buttons
  hasButton: false,
  button: null,

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
