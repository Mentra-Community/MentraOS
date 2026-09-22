import {readFile, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {parseEnv} from "node:util"
import type {CallFixture} from "./call-fixture"
import {teamsMeetingUrl} from "./teams-browser"

interface GraphMeeting {
  id?: string
  subject?: string
  startDateTime?: string
  joinWebUrl?: string
  joinMeetingIdSettings?: {joinMeetingId?: string; passcode?: string}
}

/** Creation must come from this run's signed host process and exact miniapp log scope. */
export function nativeCreatedMeeting(
  log: string,
  context: {pid: number; utcOffsetMinutes: number},
  start: number,
  end: number,
): string {
  if (
    !Number.isInteger(context.pid) ||
    context.pid <= 0 ||
    !Number.isInteger(context.utcOffsetMinutes) ||
    Math.abs(context.utcOffsetMinutes) > 840 ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    end - start > 90000
  )
    throw new Error("Invalid native meeting ownership context")
  const events = [
    ...log.matchAll(
      /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) I  Mentra\[(\d+):[a-f0-9]+\] \[com\.facebook\.react\.log:javascript\] '\[MentraJSRouter\] \[com\.mentra\.call\] console\.log', \[ '\[mentra-call\] \[meeting\] teams meeting created',\n  \{ meetingId: '([A-Za-z0-9+/_=-]+)',\n    owned: true,\n    hasRef: true \} \]$/gm,
    ),
  ].filter((event) => {
    const time = Date.parse(event[1].replace(" ", "T") + "Z") + context.utcOffsetMinutes * 60000
    return Number(event[2]) === context.pid && time >= start && time <= end
  })
  if (events.length !== 1) throw new Error("Native meeting creation is missing or ambiguous")
  return events[0][3]
}

function matchesMeetingIdentity(meeting: GraphMeeting, id: string, start: number, end: number) {
  const time = Date.parse(meeting.startDateTime ?? "")
  return meeting.id === id && meeting.subject === "Mentra Call" && Number.isFinite(time) && time >= start && time <= end
}

export function matchesOwnedMeeting(
  meeting: GraphMeeting,
  id: string,
  urlText: string,
  start: number,
  end: number,
): boolean {
  if (!matchesMeetingIdentity(meeting, id, start, end)) return false
  const url = new URL(teamsMeetingUrl(urlText))
  if (url.pathname.startsWith("/meet/")) {
    const settings = meeting.joinMeetingIdSettings
    return (
      url.pathname.replace(/\/$/, "") === `/meet/${settings?.joinMeetingId?.replace(/\D/g, "")}` &&
      (url.searchParams.get("p") ?? "") === (settings?.passcode?.trim() ?? "")
    )
  }
  return meeting.joinWebUrl === url.href
}

async function porter(args: string[]): Promise<string> {
  const child = Bun.spawn(["porter", ...args], {stdout: "pipe", stderr: "pipe"})
  const timer = setTimeout(() => child.kill(), 30000)
  try {
    const [output, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code) throw new Error("Porter cleanup request failed; credentials and raw output withheld")
    return output
  } finally {
    clearTimeout(timer)
  }
}

/** Administrative test cleanup, independent of the app's Leave behavior. */
export async function retireOwnedMeeting(directory: string, config: CallFixture["cleanup"]) {
  const start = Date.parse(JSON.parse(await readFile(join(directory, "meeting-attempt-start.json"), "utf8")).at)
  const end = Date.parse(JSON.parse(await readFile(join(directory, "meeting-attempt-end.json"), "utf8")).at)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 90000)
    throw new Error("Meeting creation window is invalid; cleanup requires operator review")
  const urlFile = Bun.file(join(directory, "meeting-url.txt"))
  const meetingUrl = (await urlFile.exists()) ? teamsMeetingUrl(await urlFile.text()) : undefined
  let nativeId: string | undefined
  if (!meetingUrl) {
    const context = JSON.parse(await readFile(join(directory, "native-log-context.json"), "utf8"))
    const doctor = JSON.parse(await readFile(join(directory, "test-build-doctor.json"), "utf8"))
    if (
      context.pid !== doctor.pid ||
      context.executableSha256 !== doctor.sha256 ||
      !/^[a-f0-9]{64}$/.test(context.executableSha256 ?? "") ||
      !Number.isFinite(Date.parse(context.startedAt)) ||
      Date.parse(context.startedAt) > start
    )
      throw new Error("Native creation log does not match the verified test process")
    nativeId = nativeCreatedMeeting(await readFile(join(directory, "native-private.log"), "utf8"), context, start, end)
  }
  const scope = ["--project", config.project, "--cluster", config.cluster, "--target", config.target]
  const logs = await porter([
    "app",
    "logs",
    config.porterApp,
    ...scope,
    "--from",
    new Date(start - 1000).toISOString(),
    "--to",
    new Date(end + 1000).toISOString(),
    "--search",
    "meeting created",
    "--limit",
    "20",
  ])
  await writeFile(join(directory, "owned-meeting-server-private.log"), logs, {mode: 0o600})
  const ids = [...new Set([...logs.matchAll(/\[teams\] meeting created \(([^)]+)\)/g)].map((match) => match[1]))]
  if (ids.length !== 1) throw new Error("Meeting creation log is absent or ambiguous; retained for operator cleanup")
  if (nativeId && nativeId !== ids[0]) throw new Error("Native and server meeting IDs disagree; cleanup refused")
  // Credentials remain in memory and are never added to a command transcript.
  const env = parseEnv(await porter(["env", "pull", "--app", config.porterApp, "--merged", ...scope]))
  const required = (key: string): string => {
    const value = env[key]
    if (!value) throw new Error("Missing authorized Graph cleanup configuration")
    return value
  }
  const auth = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(required("TENANT_ID"))}/oauth2/v2.0/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: required("CLIENT_ID"),
        client_secret: required("CLIENT_SECRET"),
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!auth.ok) throw new Error(`Graph cleanup authentication HTTP ${auth.status}`)
  const token = ((await auth.json()) as {access_token?: string}).access_token
  if (!token) throw new Error("No Graph cleanup token")
  const endpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
    required("USER_ID"),
  )}/onlineMeetings/${encodeURIComponent(ids[0])}`
  const request = (method: string) =>
    fetch(endpoint, {method, headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000)})
  const before = await request("GET")
  if (!before.ok) throw new Error(`Meeting ownership verification HTTP ${before.status}`)
  const meeting = (await before.json()) as GraphMeeting
  if (
    !matchesMeetingIdentity(meeting, ids[0], start, end) ||
    (meetingUrl && !matchesOwnedMeeting(meeting, ids[0], meetingUrl, start, end))
  )
    throw new Error("Graph meeting does not match this run's creation proof, ID, subject and time; retained")
  const removed = await request("DELETE")
  if (removed.status !== 204) throw new Error(`Meeting retirement HTTP ${removed.status}`)
  const after = await request("GET")
  await writeFile(
    join(directory, "meeting-cleanup.json"),
    JSON.stringify(
      {
        meetingId: ids[0],
        deleteStatus: removed.status,
        verificationStatus: after.status,
        method: meetingUrl
          ? "Exact captured join link, Graph ID, subject and creation time"
          : "Exact native creation event from verified test PID, matching server/Graph ID, subject and creation time",
        appCleanupQualified: false,
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    {mode: 0o600},
  )
  if (after.status !== 404) throw new Error("Meeting retirement was not independently verified")
}
