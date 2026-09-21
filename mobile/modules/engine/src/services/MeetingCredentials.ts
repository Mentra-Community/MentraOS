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
  if (config.credentialSource === "miniapp") {
    if (!legacyToken?.trim()) throw new Error("This deployment requires a miniapp-supplied meeting credential")
    return {token: legacyToken, expiresOn: "", identityMode: "guest", guestReason: "legacy-credential"}
  }
  const auth = getAuth()
  const deployment = getConfigValues()
  const assertCurrentDeployment = () => {
    if (auth !== getAuth() || deployment !== getConfigValues()) {
      throw new Error("Deployment changed while obtaining meeting credentials")
    }
  }
  // No identity is different from a failed identity acquisition. Consent, expiry and network
  // errors must propagate; only the Runtime can establish that a Teams license is absent.
  const teamsToken = auth?.getTeamsToken ? await auth.getTeamsToken() : undefined
  // The acquisition can outlive a workspace switch. Check before a request can forward
  // its subject token to the current client, as well as before accepting the response.
  assertCurrentDeployment()
  const value = await cloudClientService.getMeetingCredential(teamsToken)
  assertCurrentDeployment()
  return {
    ...value,
    ...(value.identityMode === "guest" ? {guestReason: value.guestReason ?? "no-entra-identity"} : {}),
  }
}
