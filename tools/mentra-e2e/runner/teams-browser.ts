import type {Page} from "playwright-core"

export function teamsMeetingUrl(text: string): string {
  const url = new URL(text.trim())
  if (url.protocol !== "https:" || url.hostname !== "teams.microsoft.com" || url.username || url.password || url.port)
    throw new Error("Expected a work Teams HTTPS meeting URL")
  if (!/^\/(?:meet\/\d+\/?|l\/meetup-join\/[^/]+\/0)$/.test(url.pathname))
    throw new Error("Expected the generated Teams meeting link")
  return url.href
}

export type TeamsPhase = "lobby" | "connected" | "left" | "prejoin" | "signin" | "unknown"

/** A lobby is not a call, even when a camera preview or participant count is visible. */
export function classifyTeams(signals: {
  lobby: boolean
  leave: boolean
  left?: boolean
  join: boolean
  signin: boolean
}): TeamsPhase {
  if (signals.lobby) return "lobby"
  if (signals.leave) return "connected"
  if (signals.left) return "left"
  if (signals.join) return "prejoin"
  if (signals.signin) return "signin"
  return "unknown"
}

export async function teamsPhase(page: Page): Promise<TeamsPhase> {
  return classifyTeams({
    lobby: await page.getByRole("heading", {name: /Someone will let you in shortly/i}).isVisible(),
    leave: await page.getByRole("button", {name: "Leave", exact: true}).isVisible(),
    left: await page.getByRole("button", {name: /^Rejoin(?: meeting)?$/}).isVisible(),
    join: await page.getByRole("button", {name: "Join now", exact: true}).isVisible(),
    signin:
      /login\.microsoftonline\.com|login\.live\.com/.test(new URL(page.url()).hostname) ||
      (await page
        .getByRole("heading", {name: /Enter code|Sign in/})
        .first()
        .isVisible()),
  })
}

export async function videoSamples(page: Page) {
  return page.locator("video").evaluateAll((elements) =>
    elements.map((node) => {
      const element = node as HTMLVideoElement
      return {
        width: element.videoWidth,
        height: element.videoHeight,
        time: element.currentTime,
        paused: element.paused,
        readyState: element.readyState,
      }
    }),
  )
}

export function hasDecodedVideo(samples: Awaited<ReturnType<typeof videoSamples>>) {
  return samples.some((video) => video.width > 0 && video.height > 0 && !video.paused && video.readyState >= 2)
}

export function hasAdvancingVideo(
  before: Awaited<ReturnType<typeof videoSamples>>,
  after: Awaited<ReturnType<typeof videoSamples>>,
) {
  // Teams can change receive resolution as bandwidth adapts. The browser's
  // camera is verified off, so advancing decoded video is remote media.
  return after.some(
    (v, i) =>
      v.width > 0 &&
      v.height > 0 &&
      !v.paused &&
      v.readyState >= 2 &&
      hasDecodedVideo(before[i] ? [before[i]] : []) &&
      v.time > before[i].time + 1,
  )
}
