import {createHash, createHmac, timingSafeEqual} from "node:crypto"

import {exchangeAcsTeamsUserToken, isTeamsLicenseUnavailable, type TeamsSubject} from "./acs-teams.service"

const GRAPH = "https://graph.microsoft.com/v1.0"
const TIMEOUT_MS = 15_000
const CREATE_WINDOW_MS = 10 * 60 * 1000
const createWindows = new Map<string, {started: number; count: number}>()
let cachedToken: {key: string; token: string; expiresAt: number} | undefined

export class TeamsMeetingError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 429 | 502 | 503,
  ) {
    super(message)
  }
}

interface GraphConfiguration {
  tenantId: string
  clientId: string
  clientSecret: string
  organizerId: string
}

export interface CreatedTeamsMeeting {
  provider: "acs-teams"
  joinUrl: string
  meetingRef: string
  identityMode: "teams-user" | "guest"
  guestReason?: "no-entra-identity" | "teams-license-unavailable"
}

function configuration(): GraphConfiguration {
  const tenantId = process.env.TEAMS_GRAPH_TENANT_ID?.trim()
  const clientId = process.env.TEAMS_GRAPH_CLIENT_ID?.trim()
  const clientSecret = process.env.TEAMS_GRAPH_CLIENT_SECRET?.trim()
  if (!tenantId || !clientId || !clientSecret) {
    throw new TeamsMeetingError("Teams meeting creation is not configured on this Runtime", 503)
  }
  return {tenantId, clientId, clientSecret, organizerId: process.env.TEAMS_GRAPH_ORGANIZER_ID?.trim() ?? ""}
}

export async function createTeamsMeeting(input: {
  actor: string
  subject?: TeamsSubject
  title: string
  durationMinutes: number
}): Promise<CreatedTeamsMeeting> {
  const config = configuration()
  limitCreation(input.actor)
  let organizerId = config.organizerId
  let identityMode: CreatedTeamsMeeting["identityMode"] = "guest"
  let guestReason: CreatedTeamsMeeting["guestReason"] = "no-entra-identity"
  if (input.subject) {
    if (input.subject.tenantId !== config.tenantId) {
      throw new TeamsMeetingError("Teams organizer does not belong to this Runtime's Graph tenant", 403)
    }
    try {
      // Reuse Microsoft's existing license decision, not a subscription-name heuristic.
      // This token stays server-side; joining obtains its own fresh credential.
      await exchangeAcsTeamsUserToken(input.subject)
      organizerId = input.subject.objectId
      identityMode = "teams-user"
      guestReason = undefined
    } catch (error) {
      if (!isTeamsLicenseUnavailable(error)) throw error
      guestReason = "teams-license-unavailable"
    }
  }
  if (!organizerId) throw new TeamsMeetingError("A fallback Teams organizer is not configured on this Runtime", 503)

  const start = Date.now()
  const end = start + input.durationMinutes * 60_000
  const response = await graphRequest(config, `/users/${encodeURIComponent(organizerId)}/onlineMeetings`, {
    method: "POST",
    body: JSON.stringify({
      startDateTime: new Date(start).toISOString(),
      endDateTime: new Date(end).toISOString(),
      subject: input.title,
      lobbyBypassSettings: {scope: "everyone", isDialInBypassEnabled: true},
      allowedPresenters: "everyone",
      joinMeetingIdSettings: {isPasscodeRequired: true},
    }),
  })
  const meeting = (await response.json()) as {id?: unknown; joinWebUrl?: unknown}
  if (typeof meeting.id !== "string" || !meeting.id || typeof meeting.joinWebUrl !== "string") {
    throw new TeamsMeetingError("Microsoft Graph returned an invalid meeting", 502)
  }
  const url = new URL(meeting.joinWebUrl)
  if (url.protocol !== "https:" || !["teams.microsoft.com", "teams.cloud.microsoft"].includes(url.hostname)) {
    throw new TeamsMeetingError("Microsoft Graph returned an invalid meeting link", 502)
  }
  // A signed ownership receipt avoids adding a Runtime database. It authorizes only
  // retiring this caller's meeting in this Graph tenant/application, never an arbitrary ID.
  const payload = Buffer.from(
    JSON.stringify({
      actor: input.actor,
      tenantId: config.tenantId,
      clientId: config.clientId,
      organizerId,
      meetingId: meeting.id,
      expiresAt: end + 24 * 60 * 60_000,
    }),
  ).toString("base64url")
  return {
    provider: "acs-teams",
    joinUrl: meeting.joinWebUrl,
    meetingRef: `${payload}.${signReference(config, payload)}`,
    identityMode,
    ...(guestReason ? {guestReason} : {}),
  }
}

/** Retiring a Graph resource does not hang up the participants in an active call. */
export async function retireTeamsMeeting(actor: string, meetingRef: string): Promise<void> {
  const config = configuration()
  const [payload, signature, extra] = meetingRef.split(".")
  const expected = signReference(config, payload ?? "")
  if (
    !payload ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new TeamsMeetingError("Invalid meeting ownership reference", 403)
  }
  let receipt
  try {
    receipt = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    throw new TeamsMeetingError("Invalid meeting ownership reference", 403)
  }
  if (
    !receipt ||
    typeof receipt !== "object" ||
    receipt.actor !== actor ||
    receipt.tenantId !== config.tenantId ||
    receipt.clientId !== config.clientId ||
    typeof receipt.expiresAt !== "number" ||
    receipt.expiresAt <= Date.now() ||
    typeof receipt.organizerId !== "string" ||
    typeof receipt.meetingId !== "string"
  ) {
    throw new TeamsMeetingError("Meeting ownership reference does not belong to this caller or has expired", 403)
  }
  await graphRequest(
    config,
    `/users/${encodeURIComponent(receipt.organizerId)}/onlineMeetings/${encodeURIComponent(receipt.meetingId)}`,
    {method: "DELETE"},
  )
}

function signReference(config: GraphConfiguration, payload: string): string {
  return createHmac("sha256", config.clientSecret).update(`mentra-teams-meeting-v1:${payload}`).digest("base64url")
}

async function graphRequest(config: GraphConfiguration, path: string, init: RequestInit): Promise<Response> {
  const token = await graphToken(config)
  let response: Response
  try {
    response = await fetch(`${GRAPH}${path}`, {
      ...init,
      headers: {"Authorization": `Bearer ${token}`, "Content-Type": "application/json"},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new TeamsMeetingError("Microsoft Graph is unavailable; the meeting operation could not be confirmed", 502)
  }
  if (response.ok || (init.method === "DELETE" && response.status === 404)) return response
  if (response.status === 403) {
    throw new TeamsMeetingError(
      "Microsoft Graph denied this organizer. Check Teams application access policy and permissions",
      403,
    )
  }
  if (response.status === 429) throw new TeamsMeetingError("Microsoft Graph is busy; try again later", 429)
  throw new TeamsMeetingError("Microsoft Graph could not complete the meeting operation", 502)
}

async function graphToken(config: GraphConfiguration): Promise<string> {
  const key = createHash("sha256").update(JSON.stringify(config)).digest("hex")
  if (cachedToken?.key === key && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token
  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "client_credentials",
          scope: "https://graph.microsoft.com/.default",
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    if (!response.ok) throw new Error("token rejected")
    const value = (await response.json()) as {access_token?: unknown; expires_in?: unknown}
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      typeof value.expires_in !== "number" ||
      value.expires_in <= 0
    ) {
      throw new Error("invalid token response")
    }
    cachedToken = {key, token: value.access_token, expiresAt: Date.now() + value.expires_in * 1000}
    return value.access_token
  } catch {
    throw new TeamsMeetingError("Runtime could not authenticate its Microsoft Graph application", 503)
  }
}

function limitCreation(actor: string): void {
  const now = Date.now()
  for (const [key, state] of createWindows) {
    if (now - state.started >= CREATE_WINDOW_MS) createWindows.delete(key)
  }
  let state = createWindows.get(actor)
  if (!state) {
    if (createWindows.size >= 10_000) throw new TeamsMeetingError("Meeting creation is temporarily at capacity", 503)
    state = {started: now, count: 0}
    createWindows.set(actor, state)
  }
  if (state.count >= 12) throw new TeamsMeetingError("Too many meeting creation requests; try again later", 429)
  state.count += 1
}

export function resetTeamsMeetingStateForTests(): void {
  cachedToken = undefined
  createWindows.clear()
}
