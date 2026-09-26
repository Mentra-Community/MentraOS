import {DeviceIntegrationRegistry} from "./types"
import {mentraLiveIntegration} from "./mentra-live/definition"
import {nimoIntegration} from "./nimo/definition"
import {ar99Integration} from "./ar99/definition"

/** Bundled composition only. Generic update services never import these implementations. */
export const deviceIntegrations = new DeviceIntegrationRegistry([
  mentraLiveIntegration,
  nimoIntegration,
  ar99Integration,
])
