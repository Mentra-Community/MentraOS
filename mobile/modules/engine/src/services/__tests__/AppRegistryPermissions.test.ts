import {describe, expect, test} from "bun:test"

import {normalizeManifestPermissions} from "../manifestPermissions"

describe("normalizeManifestPermissions", () => {
  test("keeps PHONE_CAMERA so opening Mentra Call can prompt for this phone's camera", () => {
    expect(
      normalizeManifestPermissions([
        {type: "CAMERA", description: "Streams your first-person view into the meeting"},
        {type: "PHONE_CAMERA", description: "Microsoft Teams requires phone camera access to publish your glasses video"},
        {type: "MICROPHONE"},
      ]),
    ).toEqual([
      {type: "CAMERA", description: "Streams your first-person view into the meeting"},
      {
        type: "PHONE_CAMERA",
        description: "Microsoft Teams requires phone camera access to publish your glasses video",
      },
      {type: "MICROPHONE"},
    ])
  })

  test("drops types the host does not know how to prompt for", () => {
    expect(normalizeManifestPermissions([{type: "NOT_A_PERMISSION"}, {type: "MICROPHONE"}])).toEqual([
      {type: "MICROPHONE"},
    ])
  })
})
