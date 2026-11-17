// The deployment's private network: a subnet for the Container Apps environment
// and, for MongoDB Atlas, a private endpoint to the Atlas project's endpoint
// service, so Core reaches its database without either side being reachable
// from the internet. Run by deploy.sh before main.bicep, which puts the
// environment in the apps subnet. An existing environment cannot be moved into
// a network: it has to be created again.
param location string = resourceGroup().location
param resourceTags object = {}
param virtualNetworkName string

@description('Address space of the network. The apps subnet takes the first /23, the endpoints subnet the /27 after it.')
param addressPrefix string = '10.40.0.0/16'

@description('Resource ID of the Atlas project\'s Azure private endpoint service (privateLinkServiceResourceId from "atlas privateEndpoints azure describe"). Empty creates no endpoint.')
param atlasPrivateLinkServiceId string = ''

var appsPrefix = cidrSubnet(addressPrefix, 23, 0)
var endpointsPrefix = cidrSubnet(addressPrefix, 27, 16)

resource network 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: virtualNetworkName
  location: location
  tags: resourceTags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      // A Consumption-only environment needs a /23 that is not delegated.
      { name: 'apps', properties: { addressPrefix: appsPrefix } }
      { name: 'endpoints', properties: { addressPrefix: endpointsPrefix } }
    ]
  }
}

// Atlas accepts the connection once the endpoint's resource ID and private IP
// are registered with it ("atlas privateEndpoints azure interfaces create"),
// hence a manual request. Atlas's private hostnames are public DNS records that
// resolve to this IP, so no private DNS zone is needed.
resource atlasEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (!empty(atlasPrivateLinkServiceId)) {
  name: '${virtualNetworkName}-atlas'
  location: location
  tags: resourceTags
  properties: {
    subnet: { id: '${network.id}/subnets/endpoints' }
    manualPrivateLinkServiceConnections: [
      {
        name: last(split(atlasPrivateLinkServiceId, '/'))
        properties: { privateLinkServiceId: atlasPrivateLinkServiceId }
      }
    ]
  }
}
