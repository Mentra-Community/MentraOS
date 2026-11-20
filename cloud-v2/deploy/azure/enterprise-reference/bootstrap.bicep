// Ownership resources that need role-assignment rights. Run by setup (Azure
// Owner, or Contributor plus User Access Administrator). main.bicep then
// deploys the application with Contributor alone, which is what CI uses.
@description('Azure region for the registry, identity and Key Vault.')
param location string = resourceGroup().location
param resourceTags object = {}

@minLength(5)
@maxLength(50)
@description('Globally unique, alphanumeric Azure Container Registry name.')
param registryName string = take('mentra${uniqueString(subscription().id, resourceGroup().id)}', 50)

@description('Core\'s identity: pulls the image and reads only Core\'s Key Vault secrets (see access.bicep).')
param coreIdentityName string = 'id-mentra-enterprise-reference-core'

@description('Runtime\'s identity: pulls the image and reads only the Teams Graph secret.')
param runtimeIdentityName string = 'id-mentra-enterprise-reference-runtime'

@description('Mentra Portal\'s identity: pulls its image and reads no secret.')
param portalIdentityName string = 'id-mentra-enterprise-reference-portal'

@description('MFM\'s identity (Mentra Fleet Management, both of its apps): pulls its image and reads only MFM\'s Key Vault secrets.')
param fleetIdentityName string = 'id-mentra-enterprise-reference-fleet'

@minLength(3)
@maxLength(24)
@description('Globally unique Key Vault holding the signing keys and other deployment secrets.')
param keyVaultName string = take('kv${uniqueString(subscription().id, resourceGroup().id)}', 24)

@description('MFM\'s raw-record archive (main.bicep fleet and fleetArchive): a storage account with one container, in which only MFM\'s identity may read, write and delete (Storage Blob Data Contributor on the container). The account takes no keys: MFM signs in with its managed identity.')
param fleetArchive bool = false

@description('The archive\'s storage account. The default is stable for this resource group; main.bicep has the same.')
param fleetArchiveStorageAccountName string = 'mfm${uniqueString(subscription().id, resourceGroup().id)}'

@description('Object ID of the person or automation running setup; gets Key Vault Secrets Officer to create deployment secrets. Empty skips the assignment.')
param operatorPrincipalId string = ''

@allowed(['User', 'ServicePrincipal', 'Group'])
param operatorPrincipalType string = 'User'

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var secretsOfficerRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: resourceTags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

// One identity per app, so a compromised app cannot read another's secrets.
// Mentra Portal and MFM have theirs even where Fleet is not installed.
var identityNames = [coreIdentityName, runtimeIdentityName, portalIdentityName, fleetIdentityName]

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for name in identityNames: {
  name: name
  location: location
  tags: resourceTags
}]

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in identityNames: {
  name: guid(registry.id, identities[i].id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: identities[i].properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}]

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: resourceTags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Replacing the signing keys signs every employee out and invalidates
    // issued tokens. Deleted keys stay recoverable and can never be purged.
    enablePurgeProtection: true
    // Same authenticated-public profile as storage.
    publicNetworkAccess: 'Enabled'
  }
}

// Apps get no vault-wide access; access.bicep grants each one only its own
// secrets once they exist. Nothing but operators can read mentra-admin-key.
resource vaultOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  name: guid(vault.id, operatorPrincipalId, secretsOfficerRoleDefinitionId)
  scope: vault
  properties: {
    principalId: operatorPrincipalId
    principalType: operatorPrincipalType
    roleDefinitionId: secretsOfficerRoleDefinitionId
  }
}

var blobContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource fleetArchiveStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (fleetArchive) {
  name: fleetArchiveStorageAccountName
  location: location
  tags: resourceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Entra sign-in only: no account keys or SAS work against it.
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
  }
}

resource fleetArchiveBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (fleetArchive) {
  parent: fleetArchiveStorage
  name: 'default'
}

resource fleetArchiveContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (fleetArchive) {
  parent: fleetArchiveBlobs
  name: 'fleet-archive'
  properties: { publicAccess: 'None' }
}

// MFM's identity, and nothing else, on this one container.
resource fleetArchiveAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (fleetArchive) {
  name: guid(fleetArchiveContainer.id, identities[3].id, blobContributorRoleDefinitionId)
  scope: fleetArchiveContainer
  properties: {
    principalId: identities[3].properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobContributorRoleDefinitionId
  }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output keyVaultName string = vault.name
output keyVaultUri string = vault.properties.vaultUri
output coreIdentityId string = identities[0].id
output runtimeIdentityId string = identities[1].id
output portalIdentityId string = identities[2].id
output fleetIdentityId string = identities[3].id
