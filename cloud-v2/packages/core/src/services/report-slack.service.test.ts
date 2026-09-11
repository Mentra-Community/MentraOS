import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

import { notifyReportSlack, type ReportSlackNotification } from "./report-slack.service";

const WEBHOOK_URL = "https://hooks.slack.test/services/T000/B000/reports";
const AUTOMATIC_WEBHOOK_URL = "https://hooks.slack.test/services/T000/B000/automatic";
const AGENT_URL = "https://dev-agent.mentraglass.com";
const BOT_TOKEN = "xoxb-test-reports-bot-token";
const CHANNEL_ID = "C0TESTMAIN";
const AUTOMATIC_CHANNEL_ID = "C0TESTAUTO";
const AGENT_SIGNING_SECRET = "test-agent-signing-secret-with-at-least-32-bytes";

const savedEnv = {
  CLOUD_REPORTS_SLACK_WEBHOOK_URL: process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL,
  CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL: process.env.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL,
  CLOUD_CORE_ENVIRONMENT: process.env.CLOUD_CORE_ENVIRONMENT,
  CLOUD_ADMIN_CONSOLE_URL: process.env.CLOUD_ADMIN_CONSOLE_URL,
  CLOUD_REPORT_AGENT_URL: process.env.CLOUD_REPORT_AGENT_URL,
  CLOUD_REPORT_AGENT_SIGNING_SECRET: process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET,
  CLOUD_REPORT_AGENT_SLACK_INTERACTIVITY_ENABLED:
    process.env.CLOUD_REPORT_AGENT_SLACK_INTERACTIVITY_ENABLED,
  CLOUD_REPORTS_SLACK_BOT_TOKEN: process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN,
  CLOUD_REPORTS_SLACK_CHANNEL_ID: process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID,
  CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC:
    process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC,
};
const realFetch = globalThis.fetch;

type FetchCall = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchCall>>;

beforeEach(() => {
  delete process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL;
  delete process.env.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL;
  delete process.env.CLOUD_ADMIN_CONSOLE_URL;
  delete process.env.CLOUD_REPORT_AGENT_URL;
  delete process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET;
  delete process.env.CLOUD_REPORT_AGENT_SLACK_INTERACTIVITY_ENABLED;
  delete process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN;
  delete process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID;
  delete process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC;
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
  restoreEnv("CLOUD_ADMIN_CONSOLE_URL", savedEnv.CLOUD_ADMIN_CONSOLE_URL);
  restoreEnv("CLOUD_REPORT_AGENT_URL", savedEnv.CLOUD_REPORT_AGENT_URL);
  restoreEnv("CLOUD_REPORT_AGENT_SIGNING_SECRET", savedEnv.CLOUD_REPORT_AGENT_SIGNING_SECRET);
  restoreEnv(
    "CLOUD_REPORT_AGENT_SLACK_INTERACTIVITY_ENABLED",
    savedEnv.CLOUD_REPORT_AGENT_SLACK_INTERACTIVITY_ENABLED,
  );
  restoreEnv("CLOUD_REPORTS_SLACK_BOT_TOKEN", savedEnv.CLOUD_REPORTS_SLACK_BOT_TOKEN);
  restoreEnv("CLOUD_REPORTS_SLACK_CHANNEL_ID", savedEnv.CLOUD_REPORTS_SLACK_CHANNEL_ID);
  restoreEnv(
    "CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC",
    savedEnv.CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC,
  );
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

  test.each(["bug", "feature"] as const)("keeps the signed confirmation URL for %s until Slack interactivity is enabled", async (kind) => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_CORE_ENVIRONMENT = "dev";
    process.env.CLOUD_REPORT_AGENT_URL = AGENT_URL;
    process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = AGENT_SIGNING_SECRET;

    const notification = kind === "bug" ? bugNotification() : featureNotification();
    await notifyReportSlack(notification);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      blocks: Array<{
        type: string;
        elements?: Array<{ text: { text: string }; url?: string; value?: string }>;
      }>;
    };
    const action = payload.blocks.find((block) => block.type === "actions")?.elements?.[0];
    expect(action?.text.text).toBe(kind === "bug" ? "Run Fix Agent" : "Run Dev Agent");
    expect(action?.value).toBeUndefined();
    const url = new URL(action?.url ?? "");
    expect(url.pathname).toBe("/actions/report");
    const expires = url.searchParams.get("expires");
    expect(url.searchParams.get("reportId")).toBe(notification.reportId);
    expect(url.searchParams.get("signature")).toBe(createHmac("sha256", AGENT_SIGNING_SECRET)
      .update(`${notification.reportId}|dev|${expires}`).digest("hex"));
  });

  test.each(["bug", "feature"] as const)("adds a signed one-click agent button for %s when Slack interactivity is enabled", async (kind) => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_CORE_ENVIRONMENT = "dev";
    process.env.CLOUD_REPORT_AGENT_URL = AGENT_URL;
    process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = AGENT_SIGNING_SECRET;
    process.env.CLOUD_REPORT_AGENT_SLACK_INTERACTIVITY_ENABLED = "true";

    const notification = kind === "bug" ? bugNotification() : featureNotification();
    await notifyReportSlack(notification);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      blocks: Array<{
        type: string;
        elements?: Array<{ text: { text: string }; action_id: string; value: string }>;
      }>;
    };
    const action = payload.blocks.find((block) => block.type === "actions")?.elements?.[0];
    expect(action?.text.text).toBe(kind === "bug" ? "Run Fix Agent" : "Run Dev Agent");
    expect(action?.action_id).toBe("run_fix_agent");
    const url = new URL(action?.value ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${AGENT_URL}/actions/report`);
    expect(url.searchParams.get("reportId")).toBe(notification.reportId);
    expect(url.searchParams.get("environment")).toBe("dev");
    const expires = url.searchParams.get("expires");
    const expectedSignature = createHmac("sha256", AGENT_SIGNING_SECRET)
      .update(`${notification.reportId}|dev|${expires}`)
      .digest("hex");
    expect(url.searchParams.get("signature")).toBe(expectedSignature);
  });

  test("does not add the agent action to other feedback or automatic reports", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_CORE_ENVIRONMENT = "prod";
    process.env.CLOUD_REPORT_AGENT_URL = AGENT_URL;
    process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = AGENT_SIGNING_SECRET;

    await notifyReportSlack(bugNotification({ kind: "feedback", feedback: { message: "hi" } }));
    await notifyReportSlack(bugNotification({ kind: "feedback", feedback: { type: "general", message: "hi" } }));
    await notifyReportSlack(bugNotification({ kind: "feedback", feedback: null }));
    await notifyReportSlack(bugNotification({ kind: "automatic" }));
    await notifyReportSlack(bugNotification({ kind: "automatic", feedback: { type: "feature" } }));

    for (const call of fetchMock.mock.calls) {
      const [, init] = call as unknown as [string, RequestInit];
      const payload = JSON.parse(String(init.body)) as { blocks: Array<{ type: string }> };
      expect(payload.blocks.some((block) => block.type === "actions")).toBe(false);
    }
  });

  test("links the report to the admin console for known environments", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_CORE_ENVIRONMENT = "dev";

    await notifyReportSlack(bugNotification());

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string; blocks: unknown[] };
    const blocksJson = JSON.stringify(payload.blocks);
    expect(blocksJson).toContain(
      "<https://admin.dev.mentraglass.com/?report=rep_TEST123|Open incident>",
    );
    expect(payload.text).toContain("https://admin.dev.mentraglass.com/?report=rep_TEST123");
  });

  test("prefers CLOUD_ADMIN_CONSOLE_URL over the derived console link", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_ADMIN_CONSOLE_URL = "https://admin.example.test/";

    await notifyReportSlack(bugNotification());

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const blocksJson = JSON.stringify(JSON.parse(String(init.body)).blocks);
    expect(blocksJson).toContain("<https://admin.example.test/?report=rep_TEST123|Open incident>");
  });

  test("shows the resolved account email as the user, mentraUserId only as fallback", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    await notifyReportSlack(bugNotification({ userEmail: "reporter@example.test" }));
    await notifyReportSlack(bugNotification({ userEmail: null }));

    const bodies = fetchMock.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)) as { text: string; blocks: unknown[] };
    });
    expect(JSON.stringify(bodies[0].blocks)).toContain("*User:*\\nreporter@example.test");
    expect(JSON.stringify(bodies[0].blocks)).not.toContain("user-1");
    expect(bodies[0].text).toContain("from reporter@example.test");
    expect(JSON.stringify(bodies[1].blocks)).toContain("*User:*\\nuser-1");
  });

  test("adds https to a schemeless CLOUD_ADMIN_CONSOLE_URL so Slack links leave Slack", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_ADMIN_CONSOLE_URL = "admin.dev.mentraglass.com";

    await notifyReportSlack(bugNotification());

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string; blocks: unknown[] };
    const blocksJson = JSON.stringify(payload.blocks);
    expect(blocksJson).toContain(
      "<https://admin.dev.mentraglass.com/?report=rep_TEST123|Open incident>",
    );
    expect(payload.text).toContain("Console: https://admin.dev.mentraglass.com/?report=rep_TEST123");
  });

  test("keeps an explicit http scheme on CLOUD_ADMIN_CONSOLE_URL", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_ADMIN_CONSOLE_URL = "http://localhost:5173";

    await notifyReportSlack(bugNotification());

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const blocksJson = JSON.stringify(JSON.parse(String(init.body)).blocks);
    expect(blocksJson).toContain("<http://localhost:5173/?report=rep_TEST123|Open incident>");
  });

  test("omits the console link and System line when environment and context are unknown", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    await notifyReportSlack(bugNotification());

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const blocksJson = JSON.stringify(JSON.parse(String(init.body)).blocks);
    expect(blocksJson).not.toContain("Open incident");
    expect(blocksJson).not.toContain("*System:*");
  });

  test("renders a System line from the raw mobile engine context", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    // Shape as the mobile island's collectDiagnosticContext actually sends it:
    // the glasses store state with a GlassesConnectionStatus object and
    // deviceModel, not a normalized connected/modelName pair.
    await notifyReportSlack(
      bugNotification({
        context: {
          app: { appVersion: "2.11.0" },
          phone: { platform: "android", deviceName: "SM-S948U", osVersion: "android 36" },
          glasses: { connection: { state: "connected" }, deviceModel: "Even Realities G2" },
          settings: { defaultWearable: "Even Realities G2" },
        },
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const blocksJson = JSON.stringify(JSON.parse(String(init.body)).blocks);
    expect(blocksJson).toContain(
      "*System:* App: 2.11.0 | Platform: android | Device: SM-S948U | OS: android 36 | Glasses: Connected (Even Realities G2) | Wearable: Even Realities G2",
    );
  });

  test("accepts a normalized glasses shape in the System line", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    await notifyReportSlack(
      bugNotification({
        context: { glasses: { connected: false, modelName: "Mentra Live" } },
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const blocksJson = JSON.stringify(JSON.parse(String(init.body)).blocks);
    expect(blocksJson).toContain("*System:* Glasses: Disconnected (Mentra Live)");
  });

  test("escapes client-sourced context values in the System line", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;

    await notifyReportSlack(
      bugNotification({
        context: { phone: { deviceName: "SM<S&>948", platform: 42, network: null } },
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const blocksJson = JSON.stringify(JSON.parse(String(init.body)).blocks);
    expect(blocksJson).toContain("Device: SM&lt;S&amp;&gt;948");
    expect(blocksJson).not.toContain("Platform: 42");
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

  test("posts through chat.postMessage when a bot token and channel are configured", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID = CHANNEL_ID;
    fetchMock.mockImplementation(async () => Response.json({ ok: true, ts: "123.456" }));

    await expect(notifyReportSlack(bugNotification())).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${BOT_TOKEN}`);
    const body = JSON.parse(String(init?.body));
    expect(body.channel).toBe(CHANNEL_ID);
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  test("keeps using the webhook when the bot token has no channel to post to", async () => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = WEBHOOK_URL;
    process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN = BOT_TOKEN;

    await notifyReportSlack(bugNotification());

    expect(String(fetchMock.mock.calls[0]![0])).toBe(WEBHOOK_URL);
  });

  test("routes automatic reports to their own channel id when the split is set", async () => {
    process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID = CHANNEL_ID;
    process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC = AUTOMATIC_CHANNEL_ID;
    fetchMock.mockImplementation(async () => Response.json({ ok: true, ts: "1.2" }));

    await notifyReportSlack(bugNotification({ kind: "automatic" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).channel).toBe(
      AUTOMATIC_CHANNEL_ID,
    );

    fetchMock.mockClear();
    delete process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC;
    await notifyReportSlack(bugNotification({ kind: "automatic" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).channel).toBe(CHANNEL_ID);
  });

  test("treats a 200 with ok:false as a failure, not a delivered message", async () => {
    process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID = CHANNEL_ID;
    // Slack answers 200 for refusals such as not_in_channel or invalid_auth.
    fetchMock.mockImplementation(async () => Response.json({ ok: false, error: "not_in_channel" }));

    await expect(notifyReportSlack(bugNotification())).resolves.toEqual({ ok: false });
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

function featureNotification(): ReportSlackNotification {
  return {
    reportId: "rep_FEATURE123",
    mentraUserId: "user-2",
    kind: "feedback",
    feedback: { type: "feature", message: "Add a setting to customize notification duration." },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
