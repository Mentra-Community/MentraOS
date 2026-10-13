/**
 * @fileoverview Mentra's layout for transactional email.
 *
 * One white card on a light grey page, as the sign-in page lays out its screens: the
 * "Mentra" wordmark, a heading, the message, one black pill button with the link
 * written out under it for clients that drop buttons, and a short footer. Every
 * style is inline and the structure is tables, because that is what mail clients
 * render reliably. Nothing loads from anywhere: no images, no web fonts, no
 * tracking. Red Hat Display is named first in the font stack and used where the
 * reader has it; everyone else gets their system's sans-serif.
 */

const FONT = "'Red Hat Display',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const TEXT = "#0a0a0a"
const MUTED = "#737373"
const BORDER = "#e5e5e5"
const PAGE = "#f5f5f5"

export interface BrandedEmail {
  /** The document title and the inbox preview line. Plain text. */
  title: string
  /** Shown by inboxes beside the subject, hidden in the message itself. Plain text. */
  preview: string
  /** Plain text. */
  heading: string
  /** The message's paragraphs, as HTML the caller has already escaped. */
  paragraphsHtml: string[]
  /** The one button; its URL is also written out under it. */
  action: {label: string; url: string}
  /** Smaller paragraphs under the button, as escaped HTML. */
  notesHtml?: string[]
  /** The last line, separated from the message. Plain text. */
  footer: string
}

/** The email as a complete HTML document. */
export function renderBrandedEmail(email: BrandedEmail): string {
  const url = escapeHtml(email.action.url)
  const paragraph = (html: string) =>
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${TEXT}">${html}</p>`
  const note = (html: string) =>
    `<p style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.6;color:${MUTED}">${html}</p>`

  return [
    `<!DOCTYPE html>`,
    `<html lang="en"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light">`,
    `<meta name="supported-color-schemes" content="light">`,
    `<title>${escapeHtml(email.title)}</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background-color:${PAGE};-webkit-text-size-adjust:100%">`,
    // The inbox preview: hidden in the message, read by the inbox list.
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(email.preview)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE}">`,
    `<tr><td align="center" style="padding:40px 16px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border:1px solid ${BORDER};border-radius:24px">`,
    `<tr><td style="padding:36px 40px 0">`,
    `<div style="font-family:${FONT};font-size:22px;line-height:1;font-weight:700;letter-spacing:-0.02em;color:${TEXT}">Mentra</div>`,
    `</td></tr>`,
    `<tr><td style="padding:32px 40px 0">`,
    `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:600;color:${TEXT}">${escapeHtml(email.heading)}</h1>`,
    ...email.paragraphsHtml.map(paragraph),
    // A table cell carries the pill's colour, so clients that ignore padding on links still draw it.
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">`,
    `<tr><td align="center" bgcolor="${TEXT}" style="border-radius:999px;background-color:${TEXT}">`,
    `<a href="${url}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:1.2;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px">${escapeHtml(email.action.label)}</a>`,
    `</td></tr></table>`,
    ...(email.notesHtml ?? []).map(note),
    note(
      `If the button doesn't work, copy this link into your browser:<br>` +
        `<a href="${url}" target="_blank" style="color:${TEXT};text-decoration:underline;word-break:break-all">${url}</a>`,
    ),
    `</td></tr>`,
    `<tr><td style="padding:12px 40px 36px">`,
    `<div style="border-top:1px solid ${BORDER};padding-top:20px;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED}">${escapeHtml(email.footer)}</div>`,
    `</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
    `</body></html>`,
  ].join("\n")
}

/** `value` safe to place in HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
