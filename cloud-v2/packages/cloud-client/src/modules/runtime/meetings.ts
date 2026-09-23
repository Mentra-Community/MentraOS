import type {HttpClient} from "../../http"

/** Host-only credentials. Never forward this object to a miniapp. */
export interface AcsMeetingCredential {
  token: string
  expiresOn: string
  identityMode: "guest" | "teams-user"
  acsUserId?: string
  guestReason?: "teams-license-unavailable"
}

export interface CreatedTeamsMeeting {
  provider: "acs-teams"
  joinUrl: string
  meetingRef: string
  identityMode: "guest" | "teams-user"
  guestReason?: "no-entra-identity" | "teams-license-unavailable"
}

export class Meetings {
  constructor(private readonly http: HttpClient) {}

  async createTeamsMeeting(
    options: {subject?: string; durationMinutes?: number},
    teamsUserAadToken?: string,
  ): Promise<CreatedTeamsMeeting> {
    const value = await this.http.post<CreatedTeamsMeeting>("/api/meetings/teams/create", {
      ...options,
      ...(teamsUserAadToken ? {teamsUserAadToken} : {}),
    })
    if (
      !value ||
      value.provider !== "acs-teams" ||
      typeof value.joinUrl !== "string" ||
      !/^https:\/\/(teams\.microsoft\.com|teams\.cloud\.microsoft)\//.test(value.joinUrl) ||
      typeof value.meetingRef !== "string" ||
      !value.meetingRef ||
      !["guest", "teams-user"].includes(value.identityMode) ||
      (teamsUserAadToken && value.identityMode === "guest" && value.guestReason !== "teams-license-unavailable") ||
      (!teamsUserAadToken && (value.identityMode !== "guest" || value.guestReason !== "no-entra-identity"))
    ) {
      throw new Error("Runtime returned an invalid created meeting")
    }
    return {
      provider: value.provider,
      joinUrl: value.joinUrl,
      meetingRef: value.meetingRef,
      identityMode: value.identityMode,
      ...(value.identityMode === "guest" ? {guestReason: value.guestReason} : {}),
    }
  }

  async retireTeamsMeeting(meetingRef: string): Promise<void> {
    await this.http.post("/api/meetings/teams/retire", {meetingRef})
  }

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
