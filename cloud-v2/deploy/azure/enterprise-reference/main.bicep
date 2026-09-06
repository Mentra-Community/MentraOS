@description('Azure region for the Core, Runtime, and database.')
param location string = resourceGroup().location

@description('Built Mentra Cloud image, including registry host and immutable digest.')
param cloudImage string

@description('Existing Azure Container Registry created by bootstrap.bicep.')
param registryName string

param tenantId string
param coreApiClientId string
param mobileClientId string

@secure()
param refreshTokenPepper string
@secure()
param mentraJwtPrivateKey string
@secure()
param mentraJwtPublicKey string
@secure()
param miniappJwtPrivateKey string
@secure()
param miniappJwtPublicKey string

@description('Optional canonical workspace hostname. DNS must point directly to the Container App before enabling it.')
param workspaceHostname string = ''

@description('Create the AcrPull assignment. Set false for CI after an administrator has bootstrapped it.')
param manageAcrPullRoleAssignment bool = true

@description('Oldest Mentra App version allowed to use this deployment (SemVer).')
param clientMinVersion string = '0.0.0'

@description('Mentra App version recommended by this deployment (SemVer). Must be >= clientMinVersion; empty defaults to clientMinVersion. deploy.sh rejects a lower value because the Mentra App evaluates the recommended floor first.')
param clientRecommendedVersion string = ''

param deploymentId string = 'mentra-enterprise-reference'
param displayName string = 'Mentra Enterprise Demo'
param environmentName string = 'cae-mentra-enterprise-reference'
param runtimeName string = 'ca-mentra-enterprise-reference'
param coreName string = 'ca-mentra-ent-ref-core'
param mongoAccountName string = take('cosmos-${uniqueString(subscription().id, resourceGroup().id)}', 44)
param pullIdentityName string = 'id-mentra-enterprise-reference-pull'
param communicationName string = take('mentra-${uniqueString(subscription().id, resourceGroup().id)}', 63)
@description('ACS data location approved by the customer, for example United States or Europe.')
param communicationDataLocation string = 'United States'
param approvedSystemMiniapps array = ['com.mentra.settings']
@description('Customer-managed userland miniapp entries: packageName, version, bundleUrl, and sha256.')
param managedMiniapps array = []
@description('Non-secret configuration exposed to opted-in miniapps: an object keyed by package name whose values are objects of string entries (keys ^[A-Za-z][A-Za-z0-9._-]{0,63}$, values <= 2048 bytes, <= 32 entries and <= 16 KiB per package). Bicep does not enforce these Mentra App limits; deploy.sh validates them before deployment.')
param miniappConfiguration object = {}
@description('Container directory holding managed miniapp ZIPs. Empty delegates these routes to customer ingress.')
param managedMiniappDirectory string = '/app/cloud-v2/deploy/azure/enterprise-reference/miniapps'
param allowedGlassesModels array = ['mentra-live']
param telemetryEnabled bool = false

@description('Organization privacy-policy URL. Empty serves the image-bundled same-origin document.')
param privacyPolicyUrl string = ''
@description('Organization terms URL. Empty serves the image-bundled same-origin document.')
param termsOfServiceUrl string = ''
param documentationUrl string = ''
param supportUrl string = ''

var loginEndpoint = az.environment().authentication.loginEndpoint
var effectiveClientRecommendedVersion = empty(clientRecommendedVersion) ? clientMinVersion : clientRecommendedVersion
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
  properties: { dataLocation: communicationDataLocation }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {}
}

resource mongo 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: mongoAccountName
  location: location
  kind: 'MongoDB'
  properties: {
    apiProperties: { serverVersion: '4.2' }
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      { name: 'EnableMongo' }
      { name: 'EnableServerless' }
    ]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    // Documented tradeoff: Core reaches Cosmos over the authenticated public
    // endpoint because this reference environment has no VNet. Disabling public
    // access requires a VNet-integrated Container Apps environment plus a Cosmos
    // private endpoint, and Container Apps outbound IPs are neither static nor
    // known before Core exists, so an IP firewall cannot be templated here.
    // Customers requiring private data-plane ingress extend this with their
    // standard VNet/private-endpoint module (see README.md, customer-setup.md).
    publicNetworkAccess: 'Enabled'
  }
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
var generatedCoreHostname = '${coreName}.${environment.properties.defaultDomain}'
var workspaceOrigin = 'https://${empty(workspaceHostname) ? generatedRuntimeHostname : workspaceHostname}'
var coreOrigin = 'https://${generatedCoreHostname}'
var mongoConnectionString = replace(mongo.listConnectionStrings().connectionStrings[0].connectionString, '/?', '/mentra-private?')
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
    coreUrl: coreOrigin
    runtimeUrl: workspaceOrigin
  }
  auth: {
    mode: 'microsoft-entra'
    authorityUrl: '${loginEndpoint}${tenantId}'
    clientId: mobileClientId
    sessionScopes: ['api://${coreApiClientId}/mentra.session']
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
    privacyPolicyUrl: empty(privacyPolicyUrl) ? '${workspaceOrigin}/legal/privacy' : privacyPolicyUrl
    termsOfServiceUrl: empty(termsOfServiceUrl) ? '${workspaceOrigin}/legal/terms' : termsOfServiceUrl
    documentationUrl: empty(documentationUrl) ? null : documentationUrl
    supportUrl: empty(supportUrl) ? null : supportUrl
  }
  systemMiniapps: { approvedPackageNamesOverride: approvedSystemMiniapps }
  miniapps: { managed: managedMiniapps, configuration: miniappConfiguration }
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

resource core 'Microsoft.App/containerApps@2024-03-01' = {
  name: coreName
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
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: pullIdentity.id
        }
      ]
      secrets: [
        { name: 'mongo-url', value: mongoConnectionString }
        { name: 'refresh-token-pepper', value: refreshTokenPepper }
        { name: 'mentra-jwt-private-key', value: mentraJwtPrivateKey }
        { name: 'mentra-jwt-public-key', value: mentraJwtPublicKey }
        { name: 'miniapp-jwt-private-key', value: miniappJwtPrivateKey }
        { name: 'miniapp-jwt-public-key', value: miniappJwtPublicKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'core'
          image: cloudImage
          command: ['bun', 'packages/core/src/index.ts']
          env: [
            { name: 'PORT', value: '3000' }
            { name: 'MONGO_URL', secretRef: 'mongo-url' }
            { name: 'REFRESH_TOKEN_PEPPER', secretRef: 'refresh-token-pepper' }
            { name: 'MENTRA_JWT_PRIVATE_KEY', secretRef: 'mentra-jwt-private-key' }
            { name: 'MENTRA_JWT_PUBLIC_KEY', secretRef: 'mentra-jwt-public-key' }
            { name: 'MENTRA_MINIAPP_JWT_PRIVATE_KEY', secretRef: 'miniapp-jwt-private-key' }
            { name: 'MENTRA_MINIAPP_JWT_PUBLIC_KEY', secretRef: 'miniapp-jwt-public-key' }
            { name: 'CLOUD_CORE_ISSUER', value: coreOrigin }
            {
              name: 'CLOUD_CORE_OIDC_PROVIDERS'
              value: '[{"id":"workforce","protocol":"oidc","providerKind":"microsoft-entra","tenantId":"${deploymentId}","issuer":"${loginEndpoint}${tenantId}/v2.0","jwksUrl":"${loginEndpoint}${tenantId}/discovery/v2.0/keys","audience":"${coreApiClientId}","subjectClaim":"oid","directoryTenantClaim":"tid","expectedDirectoryTenantId":"${tenantId}","requiredScopes":["mentra.session"],"allowedClientIds":["${mobileClientId}"]}]'
            }
            { name: 'LOG_STDOUT_JSON', value: 'true' }
            { name: 'SERVICE_NAME', value: 'core-enterprise-reference' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 20, periodSeconds: 10 }
            { type: 'Readiness', httpGet: { path: '/ready', port: 3000 }, initialDelaySeconds: 10, periodSeconds: 5 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [registryPull]
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
        customDomains: empty(workspaceHostname)
          ? []
          : [
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
          image: cloudImage
          command: ['bun', 'packages/runtime/src/index.ts']
          env: [
            { name: 'PORT', value: '3001' }
            { name: 'RUNTIME_SERVICES', value: 'meetings' }
            { name: 'MEETING_PROVIDERS', value: 'acs-teams' }
            { name: 'CLOUD_CLIENT_MIN_VERSION', value: clientMinVersion }
            { name: 'CLOUD_CLIENT_RECOMMENDED_VERSION', value: effectiveClientRecommendedVersion }
            {
              name: 'DEPLOYMENT_MANIFEST_JSON'
              value: string(deploymentManifest)
            }
            { name: 'DEPLOYMENT_PRIVACY_PATH', value: '/app/cloud-v2/deploy/azure/enterprise-reference/privacy.html' }
            { name: 'DEPLOYMENT_TERMS_PATH', value: '/app/cloud-v2/deploy/azure/enterprise-reference/terms.html' }
            {
              name: 'DEPLOYMENT_LOGO_LIGHT_PATH'
              value: '/app/cloud-v2/deploy/azure/enterprise-reference/assets/logo-light.png'
            }
            {
              name: 'DEPLOYMENT_LOGO_DARK_PATH'
              value: '/app/cloud-v2/deploy/azure/enterprise-reference/assets/logo-dark.png'
            }
            {
              name: 'DEPLOYMENT_MANAGED_MINIAPP_DIR'
              value: managedMiniappDirectory
            }
            { name: 'CLOUD_RUNTIME_AUTH_AUDIENCE', value: 'cloud-runtime' }
            {
              name: 'CLOUD_RUNTIME_AUTH_ISSUERS'
              value: '[{"issuer":"${coreOrigin}","jwksUrl":"${coreOrigin}/.well-known/jwks.json","userIdClaim":"sub","tenantIdClaim":"tenant_id","algorithms":["EdDSA"]}]'
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
output coreOrigin string = coreOrigin
output generatedRuntimeHostname string = generatedRuntimeHostname
output generatedCoreHostname string = generatedCoreHostname
output customDomainVerificationId string = environment.properties.customDomainConfiguration.customDomainVerificationId
output communicationResourceId string = communication.id
output registryLoginServer string = registry.properties.loginServer
