import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { notifyReportSlack, type ReportSlackNotification } from "./report-slack.service";

const WEBHOOK_URL = "https://hooks.slack.test/services/T000/B000/reports";
const AUTOMATIC_WEBHOOK_URL = "https://hooks.slack.test/services/T000/B000/automatic";

const savedEnv = {
  CLOUD_REPORTS_SLACK_WEBHOOK_URL: process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL,
  CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL: process.env.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL,
  CLOUD_CORE_ENVIRONMENT: process.env.CLOUD_CORE_ENVIRONMENT,
};
const realFetch = globalThis.fetch;

type FetchCall = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchCall>>;

beforeEach(() => {
  delete process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL;
  delete process.env.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL;
  process.env.CLOUD_CORE_ENVIRONMENT = "test-env";
  fetchMock = mock<FetchCall>(async () => new Response("ok", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEnv("CLOUD_REPORTS_SLACK_WEBHOOK_URL", savedEnv.CLOUD_REPORTS_SLACK_WEBHOOK_URL);
  restoreEnv(
    "CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL",
    savedEnv.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL,
  );
  restoreEnv("CLOUD_CORE_ENVIRONMENT", savedEnv.CLOUD_CORE_ENVIRONMENT);
});

describe("notifyReportSlack", () => {
  test("is a silent no-op when the webhook env var is unset", async () => {
    const result = await notifyReportSlack(bugNotification());

    expect(result).toEqual({ ok: false, skipped: true });
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  test("routes automatic reports to the automatic webhook when configured", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL = AUTOMATIC_WEBHOOK_URL;

    const result = await notifyReportSlack(bugNotification({ kind: "automatic" }));

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe(AUTOMATIC_WEBHOOK_URL);
  });

  test("falls back to the main webhook for automatic reports when the split is unset", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    const result = await notifyReportSlack(bugNotification({ kind: "automatic" }));

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe(WEBHOOK_URL);
  });

  test("keeps bug and feedback reports on the main webhook when both are configured", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL = AUTOMATIC_WEBHOOK_URL;

    await notifyReportSlack(bugNotification());
    await notifyReportSlack(bugNotification({ kind: "feedback", feedback: { message: "hi" } }));

    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[0][0]).toBe(WEBHOOK_URL);
    expect(fetchMock.mock.calls[1][0]).toBe(WEBHOOK_URL);
  });

  test("skips automatic reports silently when neither webhook is set", async () => {
    const result = await notifyReportSlack(bugNotification({ kind: "automatic" }));

    expect(result).toEqual({ ok: false, skipped: true });
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  test("posts a bug report summary with trigger, env, and artifact count", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    const result = await notifyReportSlack(bugNotification({ artifactCount: 3 }));

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");

    const payload = JSON.parse(String(init.body)) as { text: string; blocks: unknown[] };
    expect(payload.text).toContain("New bug report from user-1 (test-env)");
    expect(payload.text).toContain("rep_TEST123");
    expect(payload.text).toContain("Artifacts: 3");

    const blocksJson = JSON.stringify(payload.blocks);
    expect(blocksJson).toContain("rep_TEST123");
    expect(blocksJson).toContain("ota_update_failed");
    expect(blocksJson).toContain("glasses stuck on boot screen");
    expect(blocksJson).toContain("*Artifacts:*\\n3");
    expect(blocksJson).toContain("*Env:*\\ntest-env");
  });

  test("truncates long user-authored text", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    const longBehavior = "x".repeat(800);

    await notifyReportSlack(bugNotification({ report: { actualBehavior: longBehavior } }));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const blocksJson = JSON.stringify(JSON.parse(String(init.body)).blocks);
    expect(blocksJson).toContain(`${"x".repeat(500)}...`);
    expect(blocksJson).not.toContain("x".repeat(501));
  });

  test("posts feedback text and escapes Slack control characters", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    await notifyReportSlack({
      reportId: "rep_FEEDBACK1",
      mentraUserId: "user-2",
      kind: "feedback",
      feedback: { type: "feature", message: "more <glasses> & apps", experienceRating: 4 },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string; blocks: unknown[] };
    expect(payload.text).toContain("New feedback report from user-2 (test-env)");

    const blocksJson = JSON.stringify(payload.blocks);
    expect(blocksJson).toContain("more &lt;glasses&gt; &amp; apps");
    expect(blocksJson).toContain(":star::star::star::star: 4/5");
  });

  test("keeps every block text under Slack's 2000-char section limit", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    await notifyReportSlack({
      reportId: "rep_LIMITS",
      mentraUserId: "user-3",
      kind: "bug",
      // Worst cases: unbounded trigger strings (the API only requires
      // non-empty), and behavior text whose escaping expands 4-5x past the
      // raw truncation budget.
      trigger: { type: "manual", source: "s".repeat(5000), reason: "r".repeat(5000) },
      report: { actualBehavior: "<".repeat(5000), expectedBehavior: "&".repeat(5000) },
      artifactCount: 1,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      blocks: Array<{ text?: { text: string }; fields?: Array<{ text: string }> }>;
    };
    const texts = payload.blocks.flatMap((block) => [
      ...(block.text ? [block.text.text] : []),
      ...(block.fields ?? []).map((field) => field.text),
    ]);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(2000);
    }

    // Oversized values are truncated, not dropped.
    const blocksJson = JSON.stringify(payload.blocks);
    expect(blocksJson).toContain("r".repeat(300));
    expect(blocksJson).not.toContain("r".repeat(301));
  });

  test("resolves without throwing when the webhook request fails", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    fetchMock.mockImplementation(async () => {
      throw new Error("connection refused");
    });

    const result = await notifyReportSlack(bugNotification());

    expect(result).toEqual({ ok: false });
  });

  test("resolves without throwing on a non-2xx webhook response", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    fetchMock.mockImplementation(async () => new Response("no_service", { status: 404 }));

    const result = await notifyReportSlack(bugNotification());

    expect(result).toEqual({ ok: false });
  });
});

function bugNotification(overrides: Partial<ReportSlackNotification> = {}): ReportSlackNotification {
  return {
    reportId: "rep_TEST123",
    mentraUserId: "user-1",
    kind: "bug",
    trigger: { type: "manual", source: "feedback_screen", reason: "ota_update_failed" },
    report: { actualBehavior: "glasses stuck on boot screen", userSeverity: 4 },
    ...overrides,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
