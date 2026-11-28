import {createHash} from "node:crypto"
import {readFileSync} from "node:fs"

import {expect, test} from "bun:test"

import pkg from "../package.json"

/**
 * protocol.ts as it was when `apiLevel` last changed. A change to the contract with the Mentra App raises the level
 * (sdk/README.md, "API level"); a change that doesn't touch the contract records the file's new hash here.
 */
const PROTOCOL_AT_LEVEL = {level: 4, sha256: "5e495d4c27a6ca620a2b508dcdfe51ad356aaff82bd9b7d51976c27548ef0655"}

test("protocol.ts changes with the API level", () => {
  const sha256 = createHash("sha256")
    .update(readFileSync(new URL("./protocol.ts", import.meta.url)))
    .digest("hex")
  expect({level: pkg.apiLevel, sha256}).toEqual(PROTOCOL_AT_LEVEL)
})
