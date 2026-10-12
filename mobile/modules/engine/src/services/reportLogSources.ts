import type {IdentitySnapshot} from "./PairingIdentity"
import {DeviceTypes} from "../types"

/** Pairing identity, not Phone Mode's logical connection, determines device evidence. */
export function requiredDeviceReportLogSources(identity: IdentitySnapshot) {
  return identity.kind === "paired" && identity.model === DeviceTypes.LIVE
    ? (["phone", "glasses", "glasses_firmware"] as const)
    : (["phone"] as const)
}
