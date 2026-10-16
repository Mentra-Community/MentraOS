// CI database for the Cosmos upgrade check in cloud-v2-validation.yml.
// The account matches the `mongo` resource in ../enterprise-reference/main.bicep;
// the workflow refuses to run if the two drift apart. Each CI run uses its own
// database in this account and drops it afterwards.
//
// One-time deployment by a subscription Owner:
//   az group create --name rg-mentra-ci-core-database --location westus2
//   az deployment group create --resource-group rg-mentra-ci-core-database \
//     --template-file cloud-v2/deploy/azure/ci-database/main.bicep
// Then save the `clientId` output as the CORE_DATABASE_CI_AZURE_CLIENT_ID
// repository variable, next to CORE_DATABASE_CI_AZURE_TENANT_ID and
// CORE_DATABASE_CI_AZURE_SUBSCRIPTION_ID.

param location string = resourceGroup().location
param accountName string = 'mentra-ci-core-cosmos'
param githubRepository string = 'Mentra-Community/MentraOS'

resource mongo 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: accountName
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
      { name: 'DisableRateLimitingResponses' }
    ]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    publicNetworkAccess: 'Enabled'
  }
}

// GitHub Actions signs in as this identity through OIDC; there is no stored secret.
resource ci 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-mentra-ci-core-database'
  location: location
}

resource pullRequests 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: ci
  name: 'github-pull-requests'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:pull_request'
    audiences: ['api://AzureADTokenExchange']
  }
}

// Azure applies one federated credential change at a time on an identity.
resource devBranch 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: ci
  name: 'github-dev'
  dependsOn: [pullRequests]
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:ref:refs/heads/dev'
    audiences: ['api://AzureADTokenExchange']
  }
}

// DocumentDB Account Contributor, scoped to this resource group: enough to read
// the account's connection string, nothing outside it.
var documentDbAccountContributor = '5bd9cd88-fe45-4216-938b-f97437e15450'

resource access 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, ci.id, documentDbAccountContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', documentDbAccountContributor)
    principalId: ci.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output clientId string = ci.properties.clientId
output accountName string = mongo.name
