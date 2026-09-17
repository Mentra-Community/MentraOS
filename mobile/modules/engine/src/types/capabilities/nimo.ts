/**
 * @fileoverview NIMO hardware capabilities.
 *
 * NIMO uses framed Companion commands for Dynamic Layout V1 canvas content
 * and a separate Opus microphone channel. Requires dynamic-capable firmware.
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
    // Public logical canvas; the 540×280 physical framebuffer includes margins.
    resolution: {width: 500, height: 220},
    maxTextLines: 11,
    adjustBrightness: true,
    width: 500,
    height: 220,
    canPosition: true,
    // Host policy ceilings, not independent firmware pool guarantees. Rects
    // share the host text budget; native validates the encoded frame against
    // the aggregate 64-object / 8192-byte text / 110000-pixel / 12 KiB limits.
    maxTextElements: 32,
    maxImageElements: 4,
    maxImagePx: {width: 200, height: 200},
    shapes: ["rect"],
    // Production image encoding is 2bpp, despite the physical panel's 4bpp.
    intensityLevels: 4,
    // The communicator serializes the complete scene as a replacement frame.
    partialUpdate: false,
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
