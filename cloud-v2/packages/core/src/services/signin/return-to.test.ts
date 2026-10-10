import {expect, test} from "bun:test"

import {safeReturnTo} from "./return-to"

test.each([
  ["/admin?x=1", "/admin?x=1"],
  ["/?report=rep_01&testRun=x#step-3", "/?report=rep_01&testRun=x#step-3"],
  ["//evil.com", "/"],
  ["/\\evil.com", "/"],
  ["https://evil.com", "/"],
  ["https:evil.com", "/"],
  ["%2F%2Fevil.com", "/"],
  ["/%2F%2Fevil.com", "/"],
  ["/%5Cevil.com", "/"],
  ["/a/../../evil", "/"],
  ["/a/%2e%2e/%2E%2E/evil", "/"],
  ["/./x", "/"],
  ["/x\r\nSet-Cookie: a=b", "/"],
  ["/%0d%0aLocation:%20https://evil.com", "/"],
  ["javascript:alert(1)", "/"],
  ["", "/"],
  [`/${"a".repeat(3000)}`, "/"],
  [undefined, "/"],
  [null, "/"],
  [42, "/"],
])("safeReturnTo(%p) = %p", (raw, want) => {
  expect(safeReturnTo(raw)).toBe(want)
})
