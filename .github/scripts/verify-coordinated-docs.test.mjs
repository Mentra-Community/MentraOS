import assert from "node:assert/strict"
import test from "node:test"
import {verifyCoordinatedDocs} from "./verify-coordinated-docs.mjs"

const expected = {releaseIdentity: "3.1.0-beta.138", apkUrl: "https://example.com/app.apk", iosUrl: "https://testflight.apple.com/join/example"}
const page = `<p>${expected.releaseIdentity}</p><a href="${expected.apkUrl}">Android</a><a href="${expected.iosUrl}">iOS</a>`

test("requires release identity and both usable install links on the page", () => {
  verifyCoordinatedDocs(page, expected)
  assert.throws(() => verifyCoordinatedDocs(page.replace(expected.releaseIdentity, "3.1.0-beta.137"), expected), /missing release/)
  assert.throws(() => verifyCoordinatedDocs(page.replace(`href="${expected.apkUrl}"`, ""), expected), /missing install link/)
  assert.throws(() => verifyCoordinatedDocs(page.replace(`href="${expected.iosUrl}"`, ""), expected), /missing install link/)
})

test("rejects parse-error pages even when navigation embeds the release and URLs", () => {
  assert.throws(() => verifyCoordinatedDocs(`${page}🚧 A parsing error occurred.`, expected), /parsing-error page/)
  for (const variable of ["{{example-app-download-label}}", "%7B%7Bexample-app-url%7D%7D"]) {
    assert.throws(() => verifyCoordinatedDocs(`${page}${variable}`, expected), /Unresolved/)
  }
})
