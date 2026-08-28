import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

import {notifyMiniAppSubmissionSlack, type MiniAppSubmissionSlackNotification} from "./miniapp-slack.service"

const WEBHOOK_URL = "https://hooks.slack.test/services/T000/B000/miniapps"

const savedEnv = {
  CLOUD_MINIAPP_SLACK_WEBHOOK_URL: process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL,
  CLOUD_CORE_ENVIRONMENT: process.env.CLOUD_CORE_ENVIRONMENT,
}
const realFetch = globalThis.fetch

type FetchCall = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

let fetchMock: ReturnType<typeof mock<FetchCall>>

beforeEach(() => {
  delete process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL
  process.env.CLOUD_CORE_ENVIRONMENT = "test-env"
  fetchMock = mock<FetchCall>(async () => new Response("ok", {status: 200}))
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  restoreEnv("CLOUD_MINIAPP_SLACK_WEBHOOK_URL", savedEnv.CLOUD_MINIAPP_SLACK_WEBHOOK_URL)
  restoreEnv("CLOUD_CORE_ENVIRONMENT", savedEnv.CLOUD_CORE_ENVIRONMENT)
})

describe("notifyMiniAppSubmissionSlack", () => {
  test("is a silent no-op when the webhook env var is unset", async () => {
    const result = await notifyMiniAppSubmissionSlack(submissionNotification())

    expect(result).toEqual({ok: false, skipped: true})
    expect(fetchMock.mock.calls).toHaveLength(0)
  })

  test("posts a submission summary with app, developer, org, and env fields", async () => {
    process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL = WEBHOOK_URL

    const result = await notifyMiniAppSubmissionSlack(submissionNotification())

    expect(result).toEqual({ok: true})
    expect(fetchMock.mock.calls).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(WEBHOOK_URL)
    expect(init.method).toBe("POST")

    const payload = JSON.parse(String(init.body)) as {text: string; blocks: unknown[]}
    expect(payload.text).toContain("New miniapp release submitted: Weather v1.2.0 (com.example.weather)")
    expect(payload.text).toContain("dev@example.com (test-env)")

    const blocksJson = JSON.stringify(payload.blocks)
    expect(blocksJson).toContain("New Mini App Release Submitted")
    expect(blocksJson).toContain("*App Name:*\\nWeather")
    expect(blocksJson).toContain("*Package:*\\n`com.example.weather`")
    expect(blocksJson).toContain("*Version:*\\n1.2.0")
    expect(blocksJson).toContain("*Track:*\\nstable")
    expect(blocksJson).toContain("*Developer:*\\ndev@example.com")
    expect(blocksJson).toContain("*Org:*\\n`org_01TEST`")
    expect(blocksJson).toContain("*Env:*\\ntest-env")
    expect(blocksJson).toContain("*Description:*\\nHourly forecasts on glasses")
  })

  test("includes a type field only when the manifest carries one", async () => {
    process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL = WEBHOOK_URL

    await notifyMiniAppSubmissionSlack(submissionNotification())
    await notifyMiniAppSubmissionSlack(submissionNotification({manifest: {type: "background"}}))
    // A useless `type` (empty or non-string) must not block the appType fallback.
    await notifyMiniAppSubmissionSlack(submissionNotification({manifest: {type: "", appType: "standard"}}))
    await notifyMiniAppSubmissionSlack(submissionNotification({manifest: {type: 42, appType: "standard"}}))

    const bodyAt = (index: number) =>
      JSON.stringify(JSON.parse(String((fetchMock.mock.calls[index] as unknown as [string, RequestInit])[1].body)))
    expect(bodyAt(0)).not.toContain("*Type:*")
    expect(bodyAt(1)).toContain("*Type:*\\nbackground")
    expect(bodyAt(2)).toContain("*Type:*\\nstandard")
    expect(bodyAt(3)).toContain("*Type:*\\nstandard")
  })

  test("falls back to placeholders when email and description are missing", async () => {
    process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL = WEBHOOK_URL

    await notifyMiniAppSubmissionSlack(submissionNotification({developerEmail: null, description: null}))

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const blocksJson = JSON.stringify(JSON.parse(String(init.body)).blocks)
    expect(blocksJson).toContain("*Developer:*\\nunknown")
    expect(blocksJson).not.toContain("*Description:*")
  })

  test("truncates long descriptions and escapes Slack control characters", async () => {
    process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL = WEBHOOK_URL

    await notifyMiniAppSubmissionSlack(
      submissionNotification({
        appName: "Weather <Pro> & Friends",
        description: "d".repeat(800),
      }),
    )

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(String(init.body)) as {text: string; blocks: unknown[]}
    const blocksJson = JSON.stringify(payload.blocks)
    expect(blocksJson).toContain("Weather &lt;Pro&gt; &amp; Friends")
    expect(blocksJson).toContain(`${"d".repeat(500)}...`)
    expect(blocksJson).not.toContain("d".repeat(501))
    // The top-level fallback text is mrkdwn too, so it gets the same escaping.
    expect(payload.text).toContain("Weather &lt;Pro&gt; &amp; Friends")
    expect(payload.text).not.toContain("<Pro>")
  })

  test("keeps every block text under Slack's 2000-char section limit", async () => {
    process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL = WEBHOOK_URL

    await notifyMiniAppSubmissionSlack(
      submissionNotification({
        // Worst case: escaping expands the truncated description 4-5x past
        // its raw budget.
        appName: "<".repeat(5000),
        description: "&".repeat(5000),
      }),
    )

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(String(init.body)) as {
      blocks: Array<{text?: {text: string}; fields?: Array<{text: string}>}>
    }
    const texts = payload.blocks.flatMap((block) => [
      ...(block.text ? [block.text.text] : []),
      ...(block.fields ?? []).map((field) => field.text),
    ])
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(2000)
    }
  })

  test("resolves without throwing when the webhook request fails", async () => {
    process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL = WEBHOOK_URL
    fetchMock.mockImplementation(async () => {
      throw new Error("connection refused")
    })

    const result = await notifyMiniAppSubmissionSlack(submissionNotification())

    expect(result).toEqual({ok: false})
  })

  test("resolves without throwing on a non-2xx webhook response", async () => {
    process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL = WEBHOOK_URL
    fetchMock.mockImplementation(async () => new Response("no_service", {status: 404}))

    const result = await notifyMiniAppSubmissionSlack(submissionNotification())

    expect(result).toEqual({ok: false})
  })
})

function submissionNotification(
  overrides: Partial<MiniAppSubmissionSlackNotification> = {},
): MiniAppSubmissionSlackNotification {
  return {
    releaseId: "rel_TEST123",
    packageName: "com.example.weather",
    version: "1.2.0",
    releaseTrack: "stable",
    appName: "Weather",
    developerEmail: "dev@example.com",
    orgId: "org_01TEST",
    description: "Hourly forecasts on glasses",
    manifest: {packageName: "com.example.weather", name: "Weather", version: "1.2.0"},
    ...overrides,
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
