// Per-secret Key Vault read access, applied after the secrets exist. Core reads
// only its database's connection string, its signing keys, refresh pepper,
// admin portal sign-in secret and its side of Fleet's shared secrets; Runtime
// reads only the configured Graph app's secret and, in the Acme demo, its speech
// keys; MFM reads only its own database's connection string and its side of the
// shared secrets. Mentra Portal reads nothing. No app can read mentra-admin-key,
// which is for operators.
@description('Existing Key Vault created by bootstrap.bicep.')
param keyVaultName string
param coreIdentityName string = 'id-mentra-enterprise-reference-core'
param runtimeIdentityName string = 'id-mentra-enterprise-reference-runtime'
param fleetIdentityName string = 'id-mentra-enterprise-reference-fleet'

@description('Graph meeting-creation app. Runtime is granted its secret, teams-graph-client-secret-<client ID>, which must already exist. Empty grants nothing.')
param teamsGraphClientId string = ''

@description('Admin portal sign-in (main.bicep adminPortalSignIn). Core is granted entra-browser-client-secret, which must already exist. False grants nothing more.')
param adminPortalSignIn bool = false

@description('Acme demo speech and photos (main.bicep cloudSpeechAndPhotos). Runtime is granted soniox-api-key and elevenlabs-api-key, which must already exist. False grants nothing more.')
param cloudSpeechAndPhotos bool = false

@description('Mentra Portal and MFM (main.bicep fleet). Core is granted fleet-forwarding-secret and core-service-secrets (and, with adminPortalSignIn, oidc-workspace-portal-client-secret); MFM is granted fleet-mongo-url, fleet-forwarding-secrets and fleet-service-secret. All must already exist. False grants nothing more.')
param fleet bool = false

var secretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var coreSecrets = concat([
  'mongo-url'
  'refresh-token-pepper'
  'mentra-jwt-private-key'
  'mentra-jwt-public-key'
  'miniapp-jwt-private-key'
  'miniapp-jwt-public-key'
], adminPortalSignIn ? ['entra-browser-client-secret', 'oidc-cookie-keys', 'oidc-admin-portal-client-secret'] : [],
  fleet ? ['fleet-forwarding-secret', 'core-service-secrets'] : [],
  fleet && adminPortalSignIn ? ['oidc-workspace-portal-client-secret'] : [])
var runtimeSecrets = concat(
  empty(teamsGraphClientId) ? [] : ['teams-graph-client-secret-${teamsGraphClientId}'],
  cloudSpeechAndPhotos ? ['soniox-api-key', 'elevenlabs-api-key'] : []
)
var fleetSecrets = fleet ? ['fleet-mongo-url', 'fleet-forwarding-secrets', 'fleet-service-secret'] : []

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource coreIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: coreIdentityName
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: runtimeIdentityName
}

resource fleetIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: fleetIdentityName
}

resource coreSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for name in coreSecrets: {
  parent: vault
  name: name
}]

resource runtimeSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for name in runtimeSecrets: {
  parent: vault
  name: name
}]

resource coreRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in coreSecrets: {
  name: guid(coreSecret[i].id, coreIdentity.id, secretsUserRoleDefinitionId)
  scope: coreSecret[i]
  properties: {
    principalId: coreIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleDefinitionId
  }
}]

resource runtimeRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in runtimeSecrets: {
  name: guid(runtimeSecret[i].id, runtimeIdentity.id, secretsUserRoleDefinitionId)
  scope: runtimeSecret[i]
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleDefinitionId
  }
}]

resource fleetSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for name in fleetSecrets: {
  parent: vault
  name: name
}]

resource fleetRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in fleetSecrets: {
  name: guid(fleetSecret[i].id, fleetIdentity.id, secretsUserRoleDefinitionId)
  scope: fleetSecret[i]
  properties: {
    principalId: fleetIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleDefinitionId
  }
}]
