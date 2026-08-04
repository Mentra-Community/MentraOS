/**
 * @fileoverview Nimo Glasses Hardware Capabilities
 *
 * Capability profile for the Nimo smart glasses model.
 * Nimo uses a framed UART-over-BLE protocol with widget/app-based content
 * updates and a separate Opus microphone channel.
 */

import type { Capabilities } from "@mentra/sdk";

/**
 * Nimo Glasses capability profile
 */
export const nimo: Capabilities = {
  modelName: "NIMO",

  // Camera capabilities - Nimo does not have a camera
  hasCamera: false,
  camera: null,

  // Display capabilities - monochrome binocular display
  hasDisplay: true,
  display: {
    count: 2,
    isColor: false,
    color: "green",
    canDisplayBitmap: true,
    // TODO: placeholder - verify against hardware screen info
    resolution: { width: 640, height: 400 },
    maxTextLines: 5,
    adjustBrightness: true,
  },

  // Microphone capabilities - Nimo streams Opus audio from both arms
  hasMicrophone: true,
  microphone: {
    count: 2,
    hasVAD: false,
  },

  // Speaker capabilities - no speaker channel in the protocol
  hasSpeaker: false,
  speaker: null,

  // IMU capabilities - head-up/head-down events only
  hasIMU: true,
  imu: null,

  // Button capabilities - capacitive touch areas on both arms
  hasButton: true,
  button: {
    count: 2,
    buttons: [
      {
        type: "press",
        events: ["press", "double_press", "long_press"],
        isCapacitive: true,
      },
      {
        type: "press",
        events: ["press", "double_press", "long_press"],
        isCapacitive: true,
      },
    ],
  },

  // Light capabilities - no lights
  hasLight: false,
  light: null,

  // Power capabilities
  power: {
    hasExternalBattery: false,
  },

  // WiFi capabilities - no WiFi
  hasWifi: false,

  // OTA capabilities - firmware is not updated over the air
  hasOta: false,
};
