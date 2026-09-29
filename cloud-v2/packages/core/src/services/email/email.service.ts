import { createLogger } from "@mentra/cloud-shared";

const logger = createLogger("core").child({ component: "email" });

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function sender(): string {
  return process.env.EMAIL_SENDER || "Mentra <noreply@mentra.glass>";
}

/**
 * Send a transactional email via Resend's HTTP API. Best-effort: if
 * RESEND_API_KEY is unset (e.g. local dev) we log and skip rather than throw,
 * so the caller (an invite) still succeeds and can fall back to the copy link.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; skipped?: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("RESEND_API_KEY not set; skipping email send");
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: sender(), to: [opts.to], subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      logger.error({ status: res.status, body: await res.text().catch(() => "") }, "resend email send failed");
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    logger.error({ error: (error as Error)?.message }, "resend email send error");
    return { ok: false };
  }
}
