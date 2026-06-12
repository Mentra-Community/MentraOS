/**
 * @fileoverview INMO Go2 Hardware Capabilities
 *
 * Capability profile for the INMO Go2 smart glasses.
 *
 * Hardware summary (from ro.product getprop):
 *   SoC        : Unisoc UMS312 (Cortex-A55, armeabi-v7a)
 *   Camera     : IMX471v1 rear-facing, 4 MP  (confirmed via vendor.cam.sensor.info)
 *   Display    : Waveguide monocular AR display (no bitmap rendering via ASG client)
 *   Microphone : Single built-in mic
 *   Speaker    : Single built-in speaker
 *   IMU        : Accelerometer + Gyroscope (6-axis)
 *   Button     : One physical button + capacitive touchpad
 *   WiFi       : 2.4 GHz + 5 GHz (ro.wifi.sup_sprd = true)
 */

import type { Capabilities } from "../hardware";

/**
 * INMO Go2 capability profile
 */
export const inmoGo2: Capabilities = {
  modelName: "INMO Go2",

  // Camera — single rear-facing IMX471v1 (4 MP), supports video recording and streaming
  hasCamera: true,
  camera: {
    resolution: { width: 2688, height: 1520 }, // IMX471v1 native (4 MP)
    hasHDR: false,
    hasFocus: true,
    video: {
      canRecord: true,
      canStream: true,
      supportedStreamTypes: ["rtmp"],
      supportedResolutions: [
        { width: 1920, height: 1080 },
        { width: 1280, height: 720 },
        { width: 640,  height: 480  },
      ],
    },
  },

  // Display — monocular waveguide AR overlay; no bitmap rendering from phone side
  hasDisplay: true,
display: {
  count: 1,
  isColor: false,
  color: "green",
  canDisplayBitmap: true,   // Android WindowManager can render bitmaps
  maxTextLines: 10,
  adjustBrightness: false,  // Not yet implemented in ASG client
  resolution: { width: 640, height: 480 }, // Go2 waveguide effective resolution
  fieldOfView: { horizontal: 20, vertical: 15 }, // approx INMO Go2 FOV
},
  
  // Microphone — single built-in mic; LC3 audio not supported (no BES chip)
  hasMicrophone: true,
  microphone: {
    count: 1,
    hasVAD: false,
  },

  // Speaker — single speaker
  hasSpeaker: true,
  speaker: {
    count: 1,
    isPrivate: false,
  },

  // IMU — standard Android 6-axis (accelerometer + gyroscope)
  hasIMU: true,
  imu: {
    axisCount: 6,
    hasAccelerometer: true,
    hasCompass: false,
    hasGyroscope: true,
  },

  // Buttons — one physical button and one capacitive touchpad (side-mounted)
  hasButton: true,
  button: {
    count: 2,
    buttons: [
      {
        type: "press",
        events: ["press", "double_press", "long_press"],
        isCapacitive: false,
      },
      {
        type: "swipe1d",
        events: ["swipe_forward", "swipe_back", "press"],
        isCapacitive: true,
      },
    ],
  },

  // Light — single torch/privacy LED (camera flash used as recording indicator)
  hasLight: true,
  light: {
    count: 1,
    lights: [
      {
        id: "privacy",
        purpose: "privacy",
        isFullColor: false,
        color: "white",
        position: "front_facing",
      },
    ],
  },

  // Power — no external battery case
  power: {
    hasExternalBattery: false,
  },

  // WiFi — dual-band supported (ro.wifi.sup_sprd.support5G = true)
  hasWifi: true,
};
