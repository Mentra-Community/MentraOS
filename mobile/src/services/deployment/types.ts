export interface MentraAccountAuthConfig {
  mode: "mentra-account"
}

export interface MicrosoftEntraAuthConfig {
  mode: "microsoft-entra"
  authorityUrl: string
  clientId: string
  runtimeScopes: string[]
  teamsScopes: string[]
}

export type DeploymentAuthConfig = MentraAccountAuthConfig | MicrosoftEntraAuthConfig

export interface DeploymentManifest {
  schemaVersion: 1
  deploymentId: string
  displayName: string
  branding?: {
    logoUrls: {
      light: string
      dark: string
    }
  }
  services: {
    coreUrl: string | null
    runtimeUrl: string | null
  }
  auth: DeploymentAuthConfig
  artifacts: {
    mentraLiveOtaManifestUrl: string | null
    sttModelBaseUrl: string | null
    ttsModelBaseUrl: string | null
  }
  appUpdates: {
    mode: "store" | "managed"
    storeUrls: {
      android: string | null
      ios: string | null
    }
    reviewUrls: {
      android: string | null
      ios: string | null
    }
  }
  content: {
    wallpaperUrls: string[]
  }
  links: {
    privacyPolicyUrl: string
    termsOfServiceUrl: string
    documentationUrl: string | null
    supportUrl: string | null
  }
  systemMiniapps: {
    approvedPackageNamesOverride: string[] | null
  }
  glasses: {
    allowedModelsOverride: string[] | null
  }
  features: {
    runtimeRealtimeSession: boolean
    managedStreams: boolean
    nativeMeetings: boolean
    cloudSpeech: boolean
    onDeviceSpeech: boolean
    navigation: boolean
  }
  telemetry: boolean
}

export interface WorkspaceDeployment {
  kind: "workspace"
  source: "manual"
  workspaceOrigin: string
  manifestUrl: string
  manifest: DeploymentManifest
  activatedAt: string
}

export interface ConsumerDeployment {
  kind: "consumer"
  source: "embedded"
}

export type ActiveDeployment = ConsumerDeployment | WorkspaceDeployment

export interface DeploymentCandidate {
  workspaceOrigin: string
  manifestUrl: string
  manifest: DeploymentManifest
}
