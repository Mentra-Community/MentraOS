import {APP_STORE_REVIEW_URL, APP_STORE_URL, PLAY_STORE_URL} from "@/constants/appConfig"

import type {ConsumerDeployment, DeploymentManifest} from "./types"

/** Embedded defaults. Expo inlines these environment reads into each build. */
export function createOfficialManifest(): DeploymentManifest {
  return {
    schemaVersion: 1,
    deploymentId: "mentra-official",
    displayName: "Mentra",
    services: {
      coreUrl: process.env.EXPO_PUBLIC_CLOUD_CORE_URL?.trim() || "https://core.dev.us-west-2.mentraglass.com",
      runtimeUrl: process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL?.trim() || "https://runtime.dev.us-west-2.mentraglass.com",
    },
    auth: {mode: "mentra-account"},
    artifacts: {
      mentraLiveOtaManifestUrl: process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL?.trim() || null,
      sttModelBaseUrl: null,
      ttsModelBaseUrl: null,
    },
    appUpdates: {
      mode: "store",
      storeUrls: {android: PLAY_STORE_URL, ios: APP_STORE_URL},
      reviewUrls: {android: PLAY_STORE_URL, ios: APP_STORE_REVIEW_URL},
    },
    content: {
      wallpaperUrls: [
        "https://mentra-wallpapers.mentraglass.com/landscape1.jpeg",
        "https://mentra-wallpapers.mentraglass.com/landscape2.jpeg",
        "https://mentra-wallpapers.mentraglass.com/landscape3.jpeg",
        "https://mentra-wallpapers.mentraglass.com/trees.jpg",
        "https://mentra-wallpapers.mentraglass.com/clouds.jpeg",
        "https://mentra-wallpapers.mentraglass.com/firewatch.jpg",
      ],
    },
    links: {
      privacyPolicyUrl: "https://mentraglass.com/privacy-policy",
      termsOfServiceUrl: "https://mentraglass.com/terms-of-service",
      documentationUrl: "https://docs.mentraglass.com",
      supportUrl: null,
    },
    systemMiniapps: {approvedPackageNamesOverride: null},
    miniapps: {managed: [], configuration: {}},
    glasses: {allowedModelsOverride: null},
    features: {
      runtimeRealtimeSession: true,
      managedStreams: true,
      nativeMeetings: true,
      cloudSpeech: true,
      onDeviceSpeech: true,
      navigation: process.env.EXPO_PUBLIC_DEPLOYMENT_REGION !== "china",
    },
    telemetry: true,
  }
}

export function createConsumerDeployment(): ConsumerDeployment {
  return {kind: "consumer", source: "embedded", manifest: createOfficialManifest()}
}
