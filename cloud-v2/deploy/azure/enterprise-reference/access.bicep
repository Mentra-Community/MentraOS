// Per-secret Key Vault read access, applied after the secrets exist. Core reads
// only its signing keys and refresh pepper; Runtime reads only the Teams Graph
// secret. No app can read mentra-admin-key, which is for operators.
@description('Existing Key Vault created by bootstrap.bicep.')
param keyVaultName string
param coreIdentityName string = 'id-mentra-enterprise-reference-core'
param runtimeIdentityName string = 'id-mentra-enterprise-reference-runtime'

@description('Grant Runtime the teams-graph-client-secret; it must already exist.')
param teamsSecret bool = false

var secretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var coreSecrets = [
  'refresh-token-pepper'
  'mentra-jwt-private-key'
  'mentra-jwt-public-key'
  'miniapp-jwt-private-key'
  'miniapp-jwt-public-key'
]
var runtimeSecrets = teamsSecret ? ['teams-graph-client-secret'] : []

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource coreIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: coreIdentityName
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: runtimeIdentityName
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
