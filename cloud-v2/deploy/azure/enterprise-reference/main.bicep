@description('Azure region for the Runtime container and registry.')
param location string = resourceGroup().location

@description('Built Runtime image, including registry host and immutable tag or digest.')
param runtimeImage string

@secure()
@description('Cloudflare Stream account id.')
param cloudflareAccountId string

@secure()
@description('Cloudflare API token with Stream Edit permission.')
param cloudflareApiToken string

param tenantId string
param runtimeApiClientId string
param mobileClientId string

var registryName = 'mentraenterpriseref'
var environmentName = 'cae-mentra-enterprise-reference'
var runtimeName = 'ca-mentra-enterprise-reference'
var communicationName = 'mentra-enterprise-reference'
var loginEndpoint = az.environment().authentication.loginEndpoint
var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-mentra-enterprise-reference-pull'
  location: location
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
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: pullIdentity.id
        }
      ]
      secrets: [
        { name: 'acs-connection-string', value: communication.listKeys().primaryConnectionString }
        { name: 'cloudflare-account-id', value: cloudflareAccountId }
        { name: 'cloudflare-api-token', value: cloudflareApiToken }
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
            { name: 'RUNTIME_SERVICES', value: 'managed-streams,meetings' }
            {
              name: 'DEPLOYMENT_MANIFEST_PATH'
              value: '/app/cloud-v2/deploy/azure/enterprise-reference/mentra-deployment.json'
            }
            { name: 'DEPLOYMENT_PRIVACY_PATH', value: '/app/cloud-v2/deploy/azure/enterprise-reference/privacy.html' }
            { name: 'DEPLOYMENT_TERMS_PATH', value: '/app/cloud-v2/deploy/azure/enterprise-reference/terms.html' }
            { name: 'CLOUD_RUNTIME_AUTH_AUDIENCE', value: runtimeApiClientId }
            {
              name: 'CLOUD_RUNTIME_AUTH_ISSUERS'
              value: '[{"issuer":"${loginEndpoint}${tenantId}/v2.0","jwksUrl":"${loginEndpoint}${tenantId}/discovery/v2.0/keys","userIdClaim":"oid","fixedTenantId":"${tenantId}","requiredScopes":["mentra.runtime"],"allowedClientIds":["${mobileClientId}"]}]'
            }
            { name: 'ENTRA_TENANT_ID', value: tenantId }
            { name: 'ENTRA_CLIENT_ID', value: mobileClientId }
            { name: 'ACS_CONNECTION_STRING', secretRef: 'acs-connection-string' }
            { name: 'CF_STREAM_ACCOUNT_ID', secretRef: 'cloudflare-account-id' }
            { name: 'CF_STREAM_API_TOKEN', secretRef: 'cloudflare-api-token' }
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

output workspaceOrigin string = 'https://${runtime.properties.configuration.ingress.fqdn}'
output communicationResourceId string = communication.id
output registryLoginServer string = registry.properties.loginServer
