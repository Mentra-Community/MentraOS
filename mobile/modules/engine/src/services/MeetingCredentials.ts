import type {AcsMeetingCredential} from "@mentra/cloud-client"
import type {MeetingConfiguration, MeetingGuestReason, MeetingIdentityMode} from "@mentra/miniapp"

import {getAuth, getConfigValues, isFeatureEnabled} from "../runtime/bootstrap"
import {cloudClientService} from "./CloudClientService"

export interface MeetingIdentity {
  identityMode: MeetingIdentityMode
  guestReason?: MeetingGuestReason
}

export function meetingConfiguration(): MeetingConfiguration {
  const privateMeetings = getConfigValues().privateMeetings === true
  return {
    enabled: isFeatureEnabled("nativeMeetings"),
    credentialSource: privateMeetings ? "runtime" : "miniapp",
    externalBackendAllowed: !privateMeetings,
    managedStreams: isFeatureEnabled("managedStreams"),
  }
}

export async function meetingCredential(
  legacyToken?: string,
): Promise<Omit<AcsMeetingCredential, "guestReason"> & MeetingIdentity> {
  const config = meetingConfiguration()
  if (!config.enabled) throw new Error("Native meetings are disabled by this deployment")
  if (config.credentialSource === "miniapp" && legacyToken) {
    return {token: legacyToken, expiresOn: "", identityMode: "guest", guestReason: "legacy-credential"}
  }
  const auth = getAuth()
  // No identity is different from a failed identity acquisition. Consent, expiry and network
  // errors must propagate; only the Runtime can establish that a Teams license is absent.
  const teamsToken = auth?.getTeamsToken ? await auth.getTeamsToken() : undefined
  const value = await cloudClientService.getMeetingCredential(teamsToken)
  if (auth !== getAuth()) throw new Error("Deployment changed while obtaining meeting credentials")
  return {
    ...value,
    ...(value.identityMode === "guest" ? {guestReason: value.guestReason ?? "no-entra-identity"} : {}),
  }
}
