import {describe, expect, test} from "bun:test"

import {automaticWorkspaceName} from "./automatic-workspace.service"

describe("automaticWorkspaceName", () => {
  test("is the person's sign-in name and 's Workspace", () => {
    expect(automaticWorkspaceName({name: "Dana Reyes", email: "dana@example.com"})).toBe("Dana Reyes's Workspace")
  })

  test("trims the name and collapses its inner whitespace, line breaks included", () => {
    expect(automaticWorkspaceName({name: "  Dana   Reyes ", email: null})).toBe("Dana Reyes's Workspace")
    expect(automaticWorkspaceName({name: "Dana\n\tReyes", email: null})).toBe("Dana Reyes's Workspace")
    // Other control characters never reach a workspace name, which goes into invitation emails.
    expect(automaticWorkspaceName({name: "Dana\u0000Reyes\u007f", email: null})).toBe("Dana Reyes's Workspace")
  })

  test("without a name, is made from the email's local part, its +tag dropped", () => {
    expect(automaticWorkspaceName({name: null, email: "john.smith+test@example.com"})).toBe("John Smith's Workspace")
    expect(automaticWorkspaceName({email: "dana@x"})).toBe("Dana's Workspace")
    expect(automaticWorkspaceName({name: "   ", email: "mary_ann-lee@example.com"})).toBe("Mary Ann Lee's Workspace")
    // Empty words are skipped; each word's first letter is capitalized and the rest kept as typed.
    expect(automaticWorkspaceName({name: "", email: "..jo..McKay_@example.com"})).toBe("Jo McKay's Workspace")
  })

  test("cuts a long name so the whole is 80 characters", () => {
    const named = automaticWorkspaceName({name: "x".repeat(100), email: "dana@x"})
    expect(named).toHaveLength(80)
    expect(named).toBe(`${"x".repeat(68)}'s Workspace`)
    const mailed = automaticWorkspaceName({name: null, email: `${"y".repeat(100)}@example.com`})
    expect(mailed).toHaveLength(80)
    expect(mailed.startsWith("Y")).toBe(true)
    // A cut never leaves a space before "'s", nor half a character.
    expect(automaticWorkspaceName({name: `${"a".repeat(67)} bcd`, email: null})).toBe(`${"a".repeat(67)}'s Workspace`)
    const emoji = automaticWorkspaceName({name: `${"a".repeat(67)}😀😀`, email: null})
    expect(emoji).toBe(`${"a".repeat(67)}'s Workspace`)
  })

  test("is My Workspace with neither a name nor a usable email", () => {
    expect(automaticWorkspaceName({name: null, email: null})).toBe("My Workspace")
    expect(automaticWorkspaceName({})).toBe("My Workspace")
    expect(automaticWorkspaceName({name: "  ", email: "+tag@example.com"})).toBe("My Workspace")
    expect(automaticWorkspaceName({name: null, email: "._-@example.com"})).toBe("My Workspace")
    expect(automaticWorkspaceName({name: null, email: "not-an-address"})).toBe("My Workspace")
  })

  test("drops invisible format characters, so a name made only of them falls back to the email", () => {
    expect(automaticWorkspaceName({name: "\u200b\u200b", email: "dana@x"})).toBe("Dana's Workspace")
    expect(automaticWorkspaceName({name: "\u2060\ufeff \u200e", email: null})).toBe("My Workspace")
    expect(automaticWorkspaceName({name: "\u200eDa\u200bna\u202e Reyes", email: null})).toBe("Dana Reyes's Workspace")
    // The joiners stay inside a name, where they hold emoji sequences and Persian words together, and go at its ends.
    expect(automaticWorkspaceName({name: "\u200d\u200c", email: "dana@x"})).toBe("Dana's Workspace")
    expect(automaticWorkspaceName({name: "\u200dمی\u200cخواهم\u200c", email: null})).toBe("می\u200cخواهم's Workspace")
    expect(automaticWorkspaceName({name: "👩\u200d👩\u200d👧", email: null})).toBe("👩\u200d👩\u200d👧's Workspace")
  })

  test("never cuts a grapheme cluster: a joined emoji, a flag or a letter with its accent", () => {
    const room = 68
    const family = "👩\u200d👩\u200d👧"
    const flag = "🇫🇷"
    const accented = "e\u0301"
    for (const cluster of [family, flag, accented]) {
      // A cluster that fits is kept whole; one that straddles the limit goes entirely.
      const fits = automaticWorkspaceName({name: `${"a".repeat(room - cluster.length)}${cluster}`, email: null})
      expect(fits).toBe(`${"a".repeat(room - cluster.length)}${cluster}'s Workspace`)
      const straddles = automaticWorkspaceName({name: `${"a".repeat(room - cluster.length + 1)}${cluster}`, email: null})
      expect(straddles).toBe(`${"a".repeat(room - cluster.length + 1)}'s Workspace`)
    }
  })
})
