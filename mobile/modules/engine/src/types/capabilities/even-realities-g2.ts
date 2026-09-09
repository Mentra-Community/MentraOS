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
    maxTextLines: 8,
    adjustBrightness: true,

    // Scene display API — EvenHub retained containers.
    width: 576,
    height: 288,
    canPosition: true,
    maxTextElements: 6, // firmware text-container pool (rects share it)
    maxImageElements: 4, // firmware image-container pool
    // No maxImagePx: the SGC tiles larger images across multiple firmware
    // containers (each ≤200x100 — the hardware-verified per-container transfer
    // envelope). Pathological sizes needing more than the 4-container pool are
    // dropped SGC-side with a log.
    shapes: ["rect"], // bordered empty container ≈ rect
    intensityLevels: 2,
    partialUpdate: true,
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

  // OTA capabilities - G2 firmware updates are not driven by the ASG OTA flow
  hasOta: false,

  // Dashboard - G2 renders Even Realities' native dashboard in firmware, so
  // MentraOS does not manage the dashboard or expose dashboard settings for it
  hasNativeDashboard: true,
};
