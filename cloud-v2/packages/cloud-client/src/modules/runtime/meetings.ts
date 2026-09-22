import type {HttpClient} from "../../http"

/** Host-only credentials. Never forward this object to a miniapp. */
export interface AcsMeetingCredential {
  token: string
  expiresOn: string
  identityMode: "guest" | "teams-user"
  acsUserId?: string
  guestReason?: "teams-license-unavailable"
}

export class Meetings {
  constructor(private readonly http: HttpClient) {}

  async getAcsCredential(teamsUserAadToken?: string): Promise<AcsMeetingCredential> {
    const value = await this.http.post<AcsMeetingCredential>(
      "/api/meetings/acs/token",
      teamsUserAadToken ? {teamsUserAadToken} : {},
    )
    if (
      !value ||
      typeof value.token !== "string" ||
      !value.token ||
      !Number.isFinite(Date.parse(value.expiresOn)) ||
      Date.parse(value.expiresOn) <= Date.now() ||
      (value.identityMode !== "guest" && value.identityMode !== "teams-user") ||
      (value.identityMode === "guest" && (typeof value.acsUserId !== "string" || !value.acsUserId)) ||
      (teamsUserAadToken && value.identityMode === "guest" && value.guestReason !== "teams-license-unavailable") ||
      (!teamsUserAadToken && value.identityMode !== "guest")
    )
      throw new Error("Runtime returned an invalid meeting credential")
    return value
  }
}
