import {createLogger} from "@mentra/cloud-shared"

const logger = createLogger("store").child({component: "email"})

const RESEND_ENDPOINT = "https://api.resend.com/emails"

function sender(): string {
  return process.env.EMAIL_SENDER || "Mentra <noreply@mentra.glass>"
}

/**
 * Send a transactional email via Resend's HTTP API. Best-effort: if
 * RESEND_API_KEY is unset (e.g. local dev) we log and skip rather than throw,
 * so the caller (an invite) still succeeds and can fall back to the copy link.
 */
export async function sendEmail(opts: {
  to: string
  subject: string
  html: string
}): Promise<{ok: boolean; skipped?: boolean}> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    logger.warn("RESEND_API_KEY not set; skipping email send")
    return {ok: false, skipped: true}
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({from: sender(), to: [opts.to], subject: opts.subject, html: opts.html}),
    })
    if (!res.ok) {
      logger.error({status: res.status, body: await res.text().catch(() => "")}, "resend email send failed")
      return {ok: false}
    }
    return {ok: true}
  } catch (error) {
    logger.error({error: (error as Error)?.message}, "resend email send error")
    return {ok: false}
  }
}

export async function sendOrgInviteEmail(opts: {
  to: string
  orgName: string
  inviterName: string
  role: string
  acceptUrl: string
}): Promise<{ok: boolean; skipped?: boolean}> {
  const roleLabel = opts.role === "admin" ? "an admin" : opts.role === "owner" ? "an owner" : "a member"
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#14151b">
      <h2 style="font-size:20px;margin:0 0 12px">You're invited to ${escapeHtml(opts.orgName)}</h2>
      <p style="font-size:15px;line-height:1.6;color:#3c3f46;margin:0 0 20px">
        ${escapeHtml(opts.inviterName)} invited you to join <strong>${escapeHtml(opts.orgName)}</strong>
        as ${roleLabel} on the Mentra developer console.
      </p>
      <p style="margin:0 0 28px">
        <a href="${escapeHtml(opts.acceptUrl)}" style="display:inline-block;background:#111217;color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-size:15px;font-weight:600">Accept invitation</a>
      </p>
      <p style="font-size:13px;line-height:1.6;color:#8a8d95;margin:0">
        Or paste this link into your browser:<br/>
        <span style="word-break:break-all">${escapeHtml(opts.acceptUrl)}</span>
      </p>
    </div>`
  return sendEmail({to: opts.to, subject: `You're invited to ${opts.orgName} on Mentra`, html})
}

export async function sendMiniappBetaInviteEmail(opts: {
  to: string
  packageName: string
  inviterName: string
}): Promise<{ok: boolean; skipped?: boolean}> {
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#14151b">
      <h2 style="font-size:20px;margin:0 0 12px">You're invited to a private miniapp beta</h2>
      <p style="font-size:15px;line-height:1.6;color:#3c3f46;margin:0 0 20px">
        ${escapeHtml(opts.inviterName)} invited your Mentra account to test
        <strong>${escapeHtml(opts.packageName)}</strong>.
      </p>
      <p style="font-size:15px;line-height:1.6;color:#3c3f46;margin:0 0 20px">
        Open this miniapp in the Mentra Miniapp Store and choose <strong>Join private beta</strong>.
        The invitation is already bound to this email address; no invitation code is required.
      </p>
      <p style="font-size:13px;line-height:1.6;color:#8a8d95;margin:0">
        If you weren't expecting this invitation, you can ignore this message.
      </p>
    </div>`
  return sendEmail({to: opts.to, subject: `Private beta invitation for ${opts.packageName}`, html})
}

export async function sendPrivateMiniappInviteEmail(opts: {
  to: string
  packageName: string
  inviterName: string
}): Promise<{ok: boolean; skipped?: boolean}> {
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#14151b">
      <h2 style="font-size:20px;margin:0 0 12px">You're invited to a private Mentra miniapp</h2>
      <p style="font-size:15px;line-height:1.6;color:#3c3f46;margin:0 0 20px">
        ${escapeHtml(opts.inviterName)} gave your Mentra account access to
        <strong>${escapeHtml(opts.packageName)}</strong>.
      </p>
      <p style="font-size:15px;line-height:1.6;color:#3c3f46;margin:0 0 20px">
        Open the Mentra Miniapp Store while signed into this email address to install it.
        No invitation code is required.
      </p>
      <p style="font-size:13px;line-height:1.6;color:#8a8d95;margin:0">
        If you weren't expecting this invitation, you can ignore this message.
      </p>
    </div>`
  return sendEmail({to: opts.to, subject: `Private miniapp invitation for ${opts.packageName}`, html})
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
