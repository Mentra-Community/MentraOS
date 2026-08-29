/**
 * @fileoverview NIMO hardware capabilities.
 *
 * NIMO uses framed UART-over-BLE for widget content and a separate Opus
 * microphone channel.
 */

import type {Capabilities} from "../hardware"

export const nimo: Capabilities = {
  modelName: "NIMO",
  hasCamera: false,
  camera: null,
  hasDisplay: true,
  display: {
    count: 2,
    isColor: false,
    color: "green",
    canDisplayBitmap: true,
    // Bitmaps render into the 160x160 2bpp navigation widget. The resolution
    // below remains the existing text-display placeholder until hardware
    // screen information is available.
    resolution: {width: 640, height: 400},
    maxTextLines: 5,
    adjustBrightness: true,
  },
  hasMicrophone: true,
  microphone: {
    count: 2,
    hasVAD: false,
  },
  hasSpeaker: false,
  speaker: null,
  hasIMU: true,
  imu: null,
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
  hasLight: false,
  light: null,
  power: {
    hasExternalBattery: false,
  },
  hasWifi: false,
  hasOta: false,
}
