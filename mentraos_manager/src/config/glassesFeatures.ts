export type GlassesFeature = "camera" | "speakers" | "microphone" | "display" | "wifi"

export interface GlassesFeatureSet {
  camera: boolean
  speakers: boolean
  microphone: boolean
  display: boolean
  wifi: boolean
}

export const glassesFeatures: Record<string, GlassesFeatureSet> = {
  "Even Realities G1": {
    camera: false,
    speakers: false,
    microphone: true,
    display: true,
    wifi: false,
  },
  "Vuzix Z100": {
    camera: false,
    speakers: false,
    microphone: false,
    display: true,
    wifi: false,
  },
  "Mentra Live": {
    camera: true,
    speakers: true,
    microphone: true,
    display: false,
    wifi: true,
  },
  "Mentra Mach1": {
    camera: false,
    speakers: false,
    microphone: false,
    display: true,
    wifi: false,
  },
  "Audio Wearable": {
    camera: false,
    speakers: true,
    microphone: true,
    display: false,
    wifi: false,
  },
  "Simulated Glasses": {
    camera: true,
    speakers: true,
    microphone: true,
    display: true,
    wifi: false,
  },
}

export const featureLabels: Record<GlassesFeature, string> = {
  camera: "Camera",
  speakers: "Speakers",
  microphone: "Microphone",
  display: "Display",
  wifi: "WiFi",
}
