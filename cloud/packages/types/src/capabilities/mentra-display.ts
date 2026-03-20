/**
 * @fileoverview Mentra Display (NEX) Hardware Capabilities
 *
 * Capability profile for the Mentra Display / NEX smart glasses model.
 * Display device used for live captions and other head-up content.
 */

import type { Capabilities } from "../hardware";

/**
 * Mentra Display (NEX) capability profile
 */
export const mentraDisplay: Capabilities = {
  modelName: "Mentra Display",

  // Camera capabilities - Mentra Display does not have a camera
  hasCamera: false,
  camera: null,

  // Display capabilities - has display for captions and head-up content
  hasDisplay: true,
  display: {
    count: 1,
    isColor: false,
    color: "green",
    canDisplayBitmap: true,
    resolution: { width: 640, height: 480 },
    fieldOfView: { horizontal: 30 },
    maxTextLines: 7,
    adjustBrightness: true,
  },

  // Microphone capabilities - has microphone for live captions transcription
  hasMicrophone: true,
  microphone: {
    count: 1,
    hasVAD: true,
  },

  // Speaker capabilities - no speaker
  hasSpeaker: false,
  speaker: null,

  // IMU capabilities - no IMU
  hasIMU: false,
  imu: null,

  // Button capabilities - no physical button
  hasButton: false,
  button: null,

  // Light capabilities - no lights
  hasLight: false,
  light: null,

  // Power capabilities
  power: {
    hasExternalBattery: false,
  },

  // WiFi capabilities
  hasWifi: false,
};
