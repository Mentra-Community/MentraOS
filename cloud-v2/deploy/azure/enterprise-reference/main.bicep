@description('Azure region for the Runtime container and registry.')
param location string = resourceGroup().location

@description('Built Runtime image, including registry host and immutable tag or digest.')
param runtimeImage string

@description('Existing Azure Container Registry created by bootstrap.bicep.')
param registryName string

param tenantId string
param runtimeApiClientId string
param mobileClientId string

@description('Optional canonical workspace hostname. DNS must point directly to the Container App before enabling it.')
param workspaceHostname string = ''

@description('Create the AcrPull assignment. Set false for CI after an administrator has bootstrapped it.')
param manageAcrPullRoleAssignment bool = true

@description('Oldest Mentra App version allowed to use this deployment.')
param clientMinVersion string = '0.0.0'

@description('Mentra App version recommended by this deployment.')
param clientRecommendedVersion string = '0.0.0'

param deploymentId string = 'mentra-enterprise-reference'
param displayName string = 'Mentra Enterprise Demo'
param environmentName string = 'cae-mentra-enterprise-reference'
param runtimeName string = 'ca-mentra-enterprise-reference'
param pullIdentityName string = 'id-mentra-enterprise-reference-pull'
param communicationName string = take('mentra-${uniqueString(subscription().id, resourceGroup().id)}', 63)
param approvedSystemMiniapps array = ['com.mentra.call', 'com.mentra.settings']
param allowedGlassesModels array = ['mentra-live']
param telemetryEnabled bool = false

var loginEndpoint = az.environment().authentication.loginEndpoint
var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: pullIdentityName
  location: location
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (manageAcrPullRoleAssignment) {
  name: guid(registry.id, pullIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource communication 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: communicationName
  location: 'global'
  properties: { dataLocation: 'United States' }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {}
}

resource workspaceCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (!empty(workspaceHostname)) {
  parent: environment
  name: '${runtimeName}-workspace'
  location: location
  properties: {
    subjectName: workspaceHostname
    domainControlValidation: 'CNAME'
  }
}

var generatedRuntimeHostname = '${runtimeName}.${environment.properties.defaultDomain}'
var workspaceOrigin = 'https://${empty(workspaceHostname) ? generatedRuntimeHostname : workspaceHostname}'
var deploymentManifest = {
  schemaVersion: 1
  deploymentId: deploymentId
  displayName: displayName
  branding: {
    logoUrls: {
      light: '${workspaceOrigin}/branding/logo-light.png'
      dark: '${workspaceOrigin}/branding/logo-dark.png'
    }
  }
  services: {
    coreUrl: null
    runtimeUrl: workspaceOrigin
  }
  auth: {
    mode: 'microsoft-entra'
    authorityUrl: '${loginEndpoint}${tenantId}'
    clientId: mobileClientId
    runtimeScopes: ['api://${runtimeApiClientId}/mentra.runtime']
    teamsScopes: [
      'https://auth.msft.communication.azure.com/Teams.ManageCalls'
      'https://auth.msft.communication.azure.com/Teams.ManageChats'
    ]
  }
  artifacts: {
    mentraLiveOtaManifestUrl: null
    sttModelBaseUrl: null
    ttsModelBaseUrl: null
  }
  appUpdates: {
    mode: 'managed'
    storeUrls: { android: null, ios: null }
    reviewUrls: { android: null, ios: null }
  }
  content: { wallpaperUrls: [] }
  links: {
    privacyPolicyUrl: '${workspaceOrigin}/legal/privacy'
    termsOfServiceUrl: '${workspaceOrigin}/legal/terms'
    documentationUrl: null
    supportUrl: null
  }
  systemMiniapps: { approvedPackageNamesOverride: approvedSystemMiniapps }
  glasses: { allowedModelsOverride: allowedGlassesModels }
  features: {
    runtimeRealtimeSession: false
    managedStreams: false
    nativeMeetings: true
    cloudSpeech: false
    onDeviceSpeech: false
    navigation: false
  }
  telemetry: telemetryEnabled
}

resource runtime 'Microsoft.App/containerApps@2024-03-01' = {
  name: runtimeName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3001
        transport: 'auto'
        allowInsecure: false
        customDomains: empty(workspaceHostname) ? [] : [
          {
            name: workspaceHostname
            bindingType: 'SniEnabled'
            certificateId: workspaceCertificate.id
          }
        ]
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: pullIdentity.id
        }
      ]
      secrets: [
        { name: 'acs-connection-string', value: communication.listKeys().primaryConnectionString }
      ]
    }
    template: {
      containers: [
        {
          name: 'runtime'
          image: runtimeImage
          command: ['bun', 'packages/runtime/src/index.ts']
          env: [
            { name: 'PORT', value: '3001' }
            { name: 'RUNTIME_SERVICES', value: 'meetings' }
            { name: 'MEETING_PROVIDERS', value: 'acs-teams' }
            { name: 'CLOUD_CLIENT_MIN_VERSION', value: clientMinVersion }
            { name: 'CLOUD_CLIENT_RECOMMENDED_VERSION', value: clientRecommendedVersion }
            {
              name: 'DEPLOYMENT_MANIFEST_JSON'
              value: string(deploymentManifest)
            }
            { name: 'DEPLOYMENT_PRIVACY_PATH', value: '/app/cloud-v2/deploy/azure/enterprise-reference/privacy.html' }
            { name: 'DEPLOYMENT_TERMS_PATH', value: '/app/cloud-v2/deploy/azure/enterprise-reference/terms.html' }
            { name: 'DEPLOYMENT_LOGO_LIGHT_PATH', value: '/app/cloud-v2/deploy/azure/enterprise-reference/assets/logo-light.png' }
            { name: 'DEPLOYMENT_LOGO_DARK_PATH', value: '/app/cloud-v2/deploy/azure/enterprise-reference/assets/logo-dark.png' }
            { name: 'CLOUD_RUNTIME_AUTH_AUDIENCE', value: runtimeApiClientId }
            {
              name: 'CLOUD_RUNTIME_AUTH_ISSUERS'
              value: '[{"issuer":"${loginEndpoint}${tenantId}/v2.0","jwksUrl":"${loginEndpoint}${tenantId}/discovery/v2.0/keys","userIdClaim":"oid","fixedTenantId":"${tenantId}","requiredScopes":["mentra.runtime"],"allowedClientIds":["${mobileClientId}"]}]'
            }
            { name: 'ENTRA_TENANT_ID', value: tenantId }
            { name: 'ENTRA_CLIENT_ID', value: mobileClientId }
            { name: 'ACS_CONNECTION_STRING', secretRef: 'acs-connection-string' }
            { name: 'LOG_STDOUT_JSON', value: 'true' }
            { name: 'SERVICE_NAME', value: 'runtime-enterprise-reference' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 3001 }, initialDelaySeconds: 10, periodSeconds: 10 }
            { type: 'Readiness', httpGet: { path: '/ready', port: 3001 }, initialDelaySeconds: 5, periodSeconds: 5 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [registryPull]
}

output workspaceOrigin string = workspaceOrigin
output generatedRuntimeHostname string = generatedRuntimeHostname
output customDomainVerificationId string = environment.properties.customDomainConfiguration.customDomainVerificationId
output communicationResourceId string = communication.id
output registryLoginServer string = registry.properties.loginServer
