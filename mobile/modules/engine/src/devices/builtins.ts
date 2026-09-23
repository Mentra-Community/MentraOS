import {DeviceIntegrationRegistry} from "./types"
import {mentraLiveIntegration} from "./mentra-live/definition"
import {nimoIntegration} from "./nimo/definition"

/** Bundled composition only. Generic update services never import these implementations. */
export const deviceIntegrations = new DeviceIntegrationRegistry([mentraLiveIntegration, nimoIntegration])
