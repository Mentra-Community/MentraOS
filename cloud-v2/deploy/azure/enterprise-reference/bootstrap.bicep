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

@description('Identity the Container Apps use to pull their image and read their secrets.')
param pullIdentityName string = 'id-mentra-enterprise-reference-pull'

@minLength(3)
@maxLength(24)
@description('Globally unique Key Vault holding the signing keys and other deployment secrets.')
param keyVaultName string = take('kv${uniqueString(subscription().id, resourceGroup().id)}', 24)

@description('Object ID of the person or automation running setup; gets Key Vault Secrets Officer to create deployment secrets. Empty skips the assignment.')
param operatorPrincipalId string = ''

@allowed(['User', 'ServicePrincipal', 'Group'])
param operatorPrincipalType string = 'User'

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var secretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
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

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: pullIdentityName
  location: location
  tags: resourceTags
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

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
    // Same authenticated-public profile as Cosmos DB and storage.
    publicNetworkAccess: 'Enabled'
  }
}

resource vaultRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, pullIdentity.id, secretsUserRoleDefinitionId)
  scope: vault
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleDefinitionId
  }
}

resource vaultOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  name: guid(vault.id, operatorPrincipalId, secretsOfficerRoleDefinitionId)
  scope: vault
  properties: {
    principalId: operatorPrincipalId
    principalType: operatorPrincipalType
    roleDefinitionId: secretsOfficerRoleDefinitionId
  }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output keyVaultName string = vault.name
output keyVaultUri string = vault.properties.vaultUri
output pullIdentityId string = pullIdentity.id
