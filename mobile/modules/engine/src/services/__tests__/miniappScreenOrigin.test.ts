import {beforeEach, expect, test} from "bun:test"

import {miniappOrigin} from "../miniappOrigin"
import {miniappFileUrl, recordMiniappScreenOrigin, resetMiniappScreenOriginsForTests} from "../miniappScreenOrigin"

beforeEach(() => resetMiniappScreenOriginsForTests())

test("a file's URL is on the origin the screen loads from, under the reserved path", () => {
  recordMiniappScreenOrigin("com.mentra.ai", miniappOrigin("com.mentra.ai", "ios"))
  recordMiniappScreenOrigin("com.my_site.app", miniappOrigin("com.my_site.app", "android"))
  expect(miniappFileUrl("com.mentra.ai", "mywpiww0-abc.jpg")).toBe(
    "miniapp://com.mentra.ai/.mentra/files/mywpiww0-abc.jpg",
  )
  expect(miniappFileUrl("com.my_site.app", "mywpiww0-abc.jpg")).toBe(
    "https://com.my-site.app.miniapp.invalid/.mentra/files/mywpiww0-abc.jpg",
  )
  expect(miniappFileUrl("com.mentra.ai", "a photo#1?.jpg")).toBe(
    "miniapp://com.mentra.ai/.mentra/files/a%20photo%231%3F.jpg",
  )
})

test("a screen the app doesn't serve has no file URLs", () => {
  expect(miniappFileUrl("com.mentra.ai", "a.jpg")).toBeNull()
  recordMiniappScreenOrigin("com.mentra.ai", "miniapp://com.mentra.ai")
  // A live development build replaces the release: its screen loads from its server.
  recordMiniappScreenOrigin("com.mentra.ai", null)
  expect(miniappFileUrl("com.mentra.ai", "a.jpg")).toBeNull()
})

test("only a plain file name gets a URL", () => {
  recordMiniappScreenOrigin("com.mentra.ai", "miniapp://com.mentra.ai")
  for (const name of ["", ".", "..", "../a.jpg", "nested/a.jpg", "a\\b.jpg"]) {
    expect(miniappFileUrl("com.mentra.ai", name)).toBeNull()
  }
})
