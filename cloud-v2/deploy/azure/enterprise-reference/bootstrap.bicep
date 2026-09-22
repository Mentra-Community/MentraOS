@description('Azure region for the container registry.')
param location string = resourceGroup().location

@minLength(5)
@maxLength(50)
@description('Globally unique, alphanumeric Azure Container Registry name.')
param registryName string = take('mentra${uniqueString(subscription().id, resourceGroup().id)}', 50)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
