import {describe, expect, test} from "bun:test"

import {normalizeManifestActions} from "../manifestActions"

describe("normalizeManifestActions", () => {
  test("preserves MCP input and output schemas", () => {
    expect(
      normalizeManifestActions([
        {
          id: "start_navigation",
          description: "Start navigation.",
          parameters: {type: "object", properties: {query: {type: "string"}}},
          outputSchema: {type: "object", properties: {ok: {type: "boolean"}}},
        },
      ]),
    ).toEqual([
      {
        id: "start_navigation",
        description: "Start navigation.",
        parameters: {type: "object", properties: {query: {type: "string"}}},
        outputSchema: {type: "object", properties: {ok: {type: "boolean"}}},
      },
    ])
  })

  test("drops malformed output schemas", () => {
    expect(
      normalizeManifestActions([
        {id: "go", description: "Go.", outputSchema: ["not", "a", "schema"]},
      ]),
    ).toEqual([{id: "go", description: "Go."}])
  })
})
