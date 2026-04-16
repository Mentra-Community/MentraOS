import type { GlassesCapabilities } from "@mentra/client";

export interface DeviceProfile {
  modelId: string;
  displayName: string;
  capabilities: GlassesCapabilities;
}

export const PROFILES: Record<string, DeviceProfile> = {
  "mentra-live": {
    modelId: "mentra-live",
    displayName: "Mentra Live",
    capabilities: {
      hasDisplay: false,
      hasCamera: true,
      hasMic: true,
      hasSpeaker: true,
      hasLight: true,
      hasButtons: true,
      hasTouchpad: false,
      hasWifi: true,
    },
  },
  g1: {
    modelId: "g1",
    displayName: "Even Realities G1",
    capabilities: {
      hasDisplay: true,
      hasCamera: false,
      hasMic: true,
      hasSpeaker: false,
      hasLight: false,
      hasButtons: false,
      hasTouchpad: true,
      hasWifi: false,
      displayWidth: 640,
      displayHeight: 200,
    },
  },
  mach1: {
    modelId: "mach1",
    displayName: "Mentra Mach1",
    capabilities: {
      hasDisplay: true,
      hasCamera: false,
      hasMic: true,
      hasSpeaker: false,
      hasLight: false,
      hasButtons: true,
      hasTouchpad: false,
      hasWifi: false,
      displayWidth: 640,
      displayHeight: 480,
    },
  },
  "mentra-nex": {
    modelId: "mentra-nex",
    displayName: "Mentra Nex",
    capabilities: {
      hasDisplay: true,
      hasCamera: false,
      hasMic: true,
      hasSpeaker: false,
      hasLight: false,
      hasButtons: false,
      hasTouchpad: true,
      hasWifi: false,
      displayWidth: 640,
      displayHeight: 200,
    },
  },
};
