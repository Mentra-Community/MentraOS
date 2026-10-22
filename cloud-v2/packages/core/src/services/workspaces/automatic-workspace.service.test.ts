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
})
