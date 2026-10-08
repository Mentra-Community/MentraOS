@description('Azure region for the Core, Runtime, and database.')
param location string = resourceGroup().location

@description('Installer ownership and operator-supplied resource tags.')
param resourceTags object = {}

@description('Built Mentra Cloud image, including registry host and immutable digest.')
param cloudImage string

@description('Existing Azure Container Registry created by bootstrap.bicep.')
param registryName string

@description('Existing Key Vault created by bootstrap.bicep. It holds refresh-token-pepper, the mentra- and miniapp- JWT key pairs and, when Graph meeting creation is enabled, teams-graph-client-secret-<teamsGraphClientId>.')
param keyVaultName string

param tenantId string
param coreApiClientId string
param mobileClientId string

@description('Comma-separated Organization Admin emails (CLOUD_CORE_ADMIN_EMAILS). Include operator@private-cloud.local, the creator of the installer operator key. This is not a bearer credential.')
param coreAdminEmails string = ''

@description('Durable Core attachment storage account. The default is stable for this resource group.')
param reportStorageAccountName string = 'mentra${uniqueString(subscription().id, resourceGroup().id)}'

@description('Optional canonical workspace hostname. DNS must point directly to the Container App before enabling it.')
param workspaceHostname string = ''

@description('Managed certificate resource name for the canonical hostname. Use a new name when changing hostnames so the previous certificate can remain bound.')
param workspaceCertificateName string = '${runtimeName}-workspace'

@description('Existing hostname bindings to retain during a migration. Each entry has hostname and certificateName; the managed certificate must already exist in this Container Apps environment.')
param additionalWorkspaceDomains array = []

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
@description('Existing per-app identities created by bootstrap.bicep. Each pulls the image and reads only its own secrets.')
param coreIdentityName string = 'id-mentra-enterprise-reference-core'
param runtimeIdentityName string = 'id-mentra-enterprise-reference-runtime'
param communicationName string = take('mentra-${uniqueString(subscription().id, resourceGroup().id)}', 63)
@description('ACS data location approved by the customer, for example United States or Europe.')
param communicationDataLocation string = 'United States'
@description('Microsoft Graph tenant for meeting creation. Employee organizers must belong to this tenant.')
param teamsGraphTenantId string = tenantId
@description('Graph application with OnlineMeetings.ReadWrite.All and a Teams application access policy. Its client secret is the Key Vault secret teams-graph-client-secret-<this ID>, so a new app ID and its secret take effect together.')
param teamsGraphClientId string = ''
@description('Licensed organizer object ID used when the caller has no eligible Teams identity.')
param teamsGraphOrganizerId string = ''
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
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource coreIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: coreIdentityName
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: runtimeIdentityName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// Container Apps read the latest version of each secret with their own
// identity; nothing secret passes through deployment parameters.
var vaultUri = vault.properties.vaultUri

resource communication 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: communicationName
  location: 'global'
  tags: resourceTags
  properties: { dataLocation: communicationDataLocation }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: resourceTags
  properties: {}
}

resource mongo 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: mongoAccountName
  location: location
  tags: resourceTags
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
      // Retry metadata throttling during Core's initial index/migration setup.
      { name: 'DisableRateLimitingResponses' }
    ]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    // Azure's periodic backup. Continuous backup is not used: on API for MongoDB
    // accounts it forbids adding unique indexes, which Core creates at startup.
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
  name: workspaceCertificateName
  location: location
  properties: {
    subjectName: workspaceHostname
    domainControlValidation: 'CNAME'
  }
}

// Reuse Core's filesystem storage provider on a durable Azure Files mount.
// No attachment bytes or storage keys are exposed by the workspace manifest.
resource reportStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: reportStorageAccountName
  location: location
  tags: resourceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // The Container Apps AzureFile mount authenticates with an account key.
    allowSharedKeyAccess: true
  }
}

resource reportFileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: reportStorage
  name: 'default'
  properties: {
    shareDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource reportFiles 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: reportFileService
  name: 'core-attachments'
  properties: { shareQuota: 100, enabledProtocols: 'SMB' }
}

resource reportMount 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'core-attachments'
  properties: {
    azureFile: {
      accountName: reportStorage.name
      accountKey: reportStorage.listKeys().keys[0].value
      shareName: reportFiles.name
      accessMode: 'ReadWrite'
    }
  }
}

var generatedRuntimeHostname = '${runtimeName}.${environment.properties.defaultDomain}'
var generatedCoreHostname = '${coreName}.${environment.properties.defaultDomain}'
var workspaceOrigin = 'https://${empty(workspaceHostname) ? generatedRuntimeHostname : workspaceHostname}'
var coreOrigin = 'https://${generatedCoreHostname}'
var mongoConnectionString = replace(mongo.listConnectionStrings().connectionStrings[0].connectionString, '/?', '/mentra-private?')
var resolvedManagedMiniapps = map(managedMiniapps, app => {
      packageName: app.packageName
      version: app.version
      bundleUrl: contains(app, 'bundlePath') ? '${workspaceOrigin}${app.bundlePath}' : app.bundleUrl
      sha256: app.sha256
    })
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
  miniapps: {
    managed: resolvedManagedMiniapps
    configuration: miniappConfiguration
  }
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
  tags: resourceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${coreIdentity.id}': {} }
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
          identity: coreIdentity.id
        }
      ]
      secrets: [
        { name: 'mongo-url', value: mongoConnectionString }
        { name: 'refresh-token-pepper', keyVaultUrl: '${vaultUri}secrets/refresh-token-pepper', identity: coreIdentity.id }
        { name: 'mentra-jwt-private-key', keyVaultUrl: '${vaultUri}secrets/mentra-jwt-private-key', identity: coreIdentity.id }
        { name: 'mentra-jwt-public-key', keyVaultUrl: '${vaultUri}secrets/mentra-jwt-public-key', identity: coreIdentity.id }
        { name: 'miniapp-jwt-private-key', keyVaultUrl: '${vaultUri}secrets/miniapp-jwt-private-key', identity: coreIdentity.id }
        { name: 'miniapp-jwt-public-key', keyVaultUrl: '${vaultUri}secrets/miniapp-jwt-public-key', identity: coreIdentity.id }
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
            { name: 'CLOUD_CORE_ADMIN_EMAILS', value: coreAdminEmails }
            { name: 'CLOUD_STORAGE_PROVIDER', value: 'local' }
            { name: 'CLOUD_STORAGE_LOCAL_DIR', value: '/mnt/core-attachments' }
            {
              name: 'CLOUD_CORE_OIDC_PROVIDERS'
              value: '[{"id":"workforce","protocol":"oidc","providerKind":"microsoft-entra","tenantId":"${deploymentId}","issuer":"${loginEndpoint}${tenantId}/v2.0","jwksUrl":"${loginEndpoint}${tenantId}/discovery/v2.0/keys","audience":"${coreApiClientId}","subjectClaim":"oid","directoryTenantClaim":"tid","expectedDirectoryTenantId":"${tenantId}","requiredScopes":["mentra.session"],"allowedClientIds":["${mobileClientId}"]}]'
            }
            { name: 'LOG_STDOUT_JSON', value: 'true' }
            { name: 'SERVICE_NAME', value: 'core-enterprise-reference' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          volumeMounts: [{ volumeName: 'core-attachments', mountPath: '/mnt/core-attachments' }]
          probes: [
            { type: 'Startup', httpGet: { path: '/healthz', port: 3000 }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 60 }
            { type: 'Liveness', httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 20, periodSeconds: 10 }
            { type: 'Readiness', httpGet: { path: '/ready', port: 3000 }, initialDelaySeconds: 10, periodSeconds: 5 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
      volumes: [{ name: 'core-attachments', storageType: 'AzureFile', storageName: reportMount.name }]
    }
  }
}

var additionalWorkspaceBindings = [for domain in additionalWorkspaceDomains: {
  name: domain.hostname
  bindingType: 'SniEnabled'
  certificateId: resourceId('Microsoft.App/managedEnvironments/managedCertificates', environmentName, domain.certificateName)
}]
var workspaceAliasOrigins = [for domain in additionalWorkspaceDomains: 'https://${domain.hostname}']

resource runtime 'Microsoft.App/containerApps@2024-03-01' = {
  name: runtimeName
  location: location
  tags: resourceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${runtimeIdentity.id}': {} }
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
        customDomains: concat(empty(workspaceHostname)
          ? []
          : [
              {
                name: workspaceHostname
                bindingType: 'SniEnabled'
                certificateId: workspaceCertificate.id
              }
            ], additionalWorkspaceBindings)
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: runtimeIdentity.id
        }
      ]
      secrets: concat([
        { name: 'acs-connection-string', value: communication.listKeys().primaryConnectionString }
      ], empty(teamsGraphClientId) ? [] : [
        { name: 'teams-graph-client-secret', keyVaultUrl: '${vaultUri}secrets/teams-graph-client-secret-${teamsGraphClientId}', identity: runtimeIdentity.id }
      ])
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
            { name: 'DEPLOYMENT_WORKSPACE_ALIASES', value: string(workspaceAliasOrigins) }
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
            { name: 'TEAMS_GRAPH_TENANT_ID', value: teamsGraphTenantId }
            { name: 'TEAMS_GRAPH_CLIENT_ID', value: teamsGraphClientId }
            { name: 'TEAMS_GRAPH_ORGANIZER_ID', value: teamsGraphOrganizerId }
            union({ name: 'TEAMS_GRAPH_CLIENT_SECRET' }, empty(teamsGraphClientId) ? { value: '' } : { secretRef: 'teams-graph-client-secret' })
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
}

output workspaceOrigin string = workspaceOrigin
output coreOrigin string = coreOrigin
output generatedRuntimeHostname string = generatedRuntimeHostname
output generatedCoreHostname string = generatedCoreHostname
output customDomainVerificationId string = environment.properties.customDomainConfiguration.customDomainVerificationId
output communicationResourceId string = communication.id
output registryLoginServer string = registry.properties.loginServer
output keyVaultName string = vault.name
