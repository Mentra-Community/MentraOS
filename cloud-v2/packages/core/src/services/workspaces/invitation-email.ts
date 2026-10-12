/**
 * @fileoverview The workspace invitation email: who invited whom to which workspace, as what, and until when.
 *
 * Built here as data (subject, HTML and plain text) so its wording is tested without sending anything;
 * `invitation.service` sends it. The workspace name and the inviter's address are user-controlled text
 * and are escaped wherever they reach HTML.
 */

import type {WorkspaceRole} from "@mentra/workspace-contract"
import {escapeHtml, renderBrandedEmail} from "../email/layout"

/** Each role, capitalised, with the article the sentence needs: "as a Developer", "as an Admin". */
const ROLES: Record<WorkspaceRole, {article: string; label: string}> = {
  member: {article: "a", label: "Member"},
  developer: {article: "a", label: "Developer"},
  admin: {article: "an", label: "Admin"},
  owner: {article: "an", label: "Owner"},
}

/** "October 26, 2026": the day in UTC, the zone Core keeps time in, with no time of day. */
const EXPIRY_DATE = new Intl.DateTimeFormat("en-US", {dateStyle: "long", timeZone: "UTC"})

export interface InvitationEmailInput {
  /** The invited address. */
  to: string
  workspaceName: string
  role: WorkspaceRole
  inviteUrl: string
  expiresAt: Date
  /** The inviter's email address; null when the system sent it. */
  invitedBy: string | null
}

export interface InvitationEmail {
  subject: string
  html: string
  text: string
}

/** The invitation email for `input`, in HTML and plain text. */
export function invitationEmail(input: InvitationEmailInput): InvitationEmail {
  const {to, workspaceName, role, inviteUrl, expiresAt} = input
  const invitedBy = input.invitedBy?.trim() || null
  const {article, label} = ROLES[role] ?? {article: "a", label: role}
  const rolePhrase = `${article} ${label}`
  const expires = EXPIRY_DATE.format(expiresAt)
  const subject = `You're invited to join ${workspaceName} on Mentra`
  const heading = `Join ${workspaceName} on Mentra`
  const ignore = "If you weren't expecting this invitation, you can ignore this email. Nothing changes unless you accept it."

  // The same sentence in every form: the inbox preview, the HTML and the plain text.
  const sentence = invitedBy
    ? `${invitedBy} invited you to join ${workspaceName} on Mentra as ${rolePhrase}.`
    : `You've been invited to join ${workspaceName} on Mentra as ${rolePhrase}.`
  const strong = (value: string) => `<strong style="font-weight:600">${escapeHtml(value)}</strong>`

  const html = renderBrandedEmail({
    title: subject,
    preview: sentence,
    heading,
    paragraphsHtml: [
      invitedBy
        ? `${strong(invitedBy)} invited you to join ${strong(workspaceName)} on Mentra as ${article} ${strong(label)}.`
        : `You've been invited to join ${strong(workspaceName)} on Mentra as ${article} ${strong(label)}.`,
    ],
    action: {label: "Accept invitation", url: inviteUrl},
    notesHtml: [`To accept, sign in to Mentra with ${strong(to)}. This invitation expires on ${escapeHtml(expires)}.`],
    footer: ignore,
  })

  const text = [
    heading,
    "",
    sentence,
    "",
    "Accept the invitation:",
    inviteUrl,
    "",
    `To accept, sign in to Mentra with ${to}. This invitation expires on ${expires}.`,
    "",
    ignore,
    "",
  ].join("\n")

  return {subject, html, text}
}
