import {describe, expect, test} from "bun:test"

import {invitationEmail, type InvitationEmailInput} from "./invitation-email"

const INVITE_URL = "https://portal.example.test/?workspaceInvite=tok_abc-123"

function build(overrides: Partial<InvitationEmailInput> = {}) {
  return invitationEmail({
    to: "dev@example.test",
    workspaceName: "Dev check",
    role: "developer",
    inviteUrl: INVITE_URL,
    expiresAt: new Date("2026-10-26T01:25:48.000Z"),
    invitedBy: "alex@example.test",
    ...overrides,
  })
}

describe("the invitation email", () => {
  test("keeps the subject", () => {
    expect(build().subject).toBe("You're invited to join Dev check on Mentra")
  })

  test("says who invited them, to what, and with which role, capitalised", () => {
    const {html, text} = build()
    expect(text).toContain("alex@example.test invited you to join Dev check on Mentra as a Developer.")
    expect(html).toContain(">alex@example.test</strong> invited you to join")
    expect(html).toContain(">Dev check</strong>")
    expect(html).toContain("as a <strong style=\"font-weight:600\">Developer</strong>")
    for (const [role, phrase] of [
      ["member", "as a Member."],
      ["developer", "as a Developer."],
      ["admin", "as an Admin."],
      ["owner", "as an Owner."],
    ] as const) {
      expect(build({role}).text).toContain(phrase)
    }
    // The raw role never appears in the sentence.
    expect(build({role: "admin"}).text).not.toContain(" as admin")
  })

  test("without an inviter (the system invited them) it does not invent one", () => {
    const {html, text} = build({invitedBy: null})
    expect(text).toContain("You've been invited to join Dev check on Mentra as a Developer.")
    expect(html).toContain("You've been invited to join")
    expect(build({invitedBy: "  "}).text).toContain("You've been invited")
  })

  test("shows the expiry as a date, without a time or a time zone", () => {
    const {html, text} = build()
    for (const body of [html, text]) {
      expect(body).toContain("This invitation expires on October 26, 2026.")
      expect(body).not.toContain("GMT")
      expect(body).not.toContain("01:25")
      expect(body).not.toContain("2026-10-26")
    }
    // The UTC day, whatever the server's own zone.
    expect(build({expiresAt: new Date("2026-10-26T23:59:00.000Z")}).text).toContain("October 26, 2026")
  })

  test("tells them which address to sign in with", () => {
    const {html, text} = build()
    expect(text).toContain("To accept, sign in to Mentra with dev@example.test.")
    expect(html).toContain("sign in to Mentra with <strong")
    expect(html).toContain(">dev@example.test</strong>")
  })

  test("is a branded HTML email with a black pill button, the link written out, and a footer", () => {
    const {html} = build()
    expect(html).toStartWith("<!DOCTYPE html>")
    expect(html).toContain(">Mentra</div>")
    expect(html).toContain("<h1")
    expect(html).toContain(">Join Dev check on Mentra</h1>")
    // The button: the link on a black pill.
    expect(html).toMatch(/bgcolor="#0a0a0a" style="border-radius:999px;[^"]*">\s*<a href="https:\/\/portal\.example\.test\/\?workspaceInvite=tok_abc-123"/)
    expect(html).toContain(">Accept invitation</a>")
    // The same link written out for a client that drops the button.
    expect(html).toContain(`copy this link into your browser:<br><a href="${INVITE_URL}"`)
    expect(html).toContain(`>${INVITE_URL}</a>`)
    expect(html).toContain("If you weren&#39;t expecting this invitation, you can ignore this email.")
    // Inline styles only: no stylesheet, no class names a client would strip.
    expect(html).not.toContain("<style")
    expect(html).not.toContain("class=")
  })

  test("loads nothing from anywhere: the only URL in it is the invitation link", () => {
    const {html, text} = build()
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<link")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("url(")
    const urls = [...html.matchAll(/https?:\/\/[^\s"<]+/g)].map(match => match[0])
    expect(urls.length).toBeGreaterThan(0)
    expect(new Set(urls)).toEqual(new Set([INVITE_URL]))
    expect([...text.matchAll(/https?:\/\/\S+/g)].map(match => match[0])).toEqual([INVITE_URL])
  })

  test("the plain-text version says the same, with the link on its own line", () => {
    expect(build().text).toBe(
      [
        "Join Dev check on Mentra",
        "",
        "alex@example.test invited you to join Dev check on Mentra as a Developer.",
        "",
        "Accept the invitation:",
        INVITE_URL,
        "",
        "To accept, sign in to Mentra with dev@example.test. This invitation expires on October 26, 2026.",
        "",
        "If you weren't expecting this invitation, you can ignore this email. Nothing changes unless you accept it.",
        "",
      ].join("\n"),
    )
  })

  test("escapes user-controlled text wherever it reaches HTML", () => {
    const {subject, html, text} = build({
      workspaceName: `Acme <Labs> & "Co"`,
      invitedBy: "<script>@example.test",
      inviteUrl: "https://portal.example.test/?workspaceInvite=a&b=\"c\"",
    })
    expect(subject).toBe(`You're invited to join Acme <Labs> & "Co" on Mentra`)
    expect(html).toContain("Acme &lt;Labs&gt; &amp; &quot;Co&quot;")
    expect(html).toContain("&lt;script&gt;@example.test")
    expect(html).toContain('href="https://portal.example.test/?workspaceInvite=a&amp;b=&quot;c&quot;"')
    expect(html).not.toContain("<Labs>")
    expect(html).not.toContain("<script>")
    // The plain text is not HTML and stays as written.
    expect(text).toContain(`join Acme <Labs> & "Co" on Mentra`)
  })
})
