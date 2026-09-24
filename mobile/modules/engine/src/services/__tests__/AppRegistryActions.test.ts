import {describe, expect, test} from "bun:test"

import {normalizeManifestActions, projectSystemActions} from "../manifestActions"

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
        lifecycle: "persistent",
        audience: "system",
      },
    ])
  })

  test("drops malformed output schemas", () => {
    expect(
      normalizeManifestActions([
        {id: "go", description: "Go.", outputSchema: ["not", "a", "schema"]},
      ]),
    ).toEqual([{id: "go", description: "Go.", lifecycle: "persistent", audience: "system"}])
  })

  test("preserves transient host-only lifecycle metadata", () => {
    expect(
      normalizeManifestActions([
        {id: "reconcile", description: "Reconcile.", lifecycle: "transient", audience: "host"},
      ]),
    ).toEqual([
      {id: "reconcile", description: "Reconcile.", lifecycle: "transient", audience: "host"},
    ])
  })

  test("omits host-only actions from miniapp discovery", () => {
    const actions = normalizeManifestActions([
      {id: "open", description: "Open.", lifecycle: "persistent"},
      {id: "reconcile", description: "Reconcile.", lifecycle: "transient", audience: "host"},
    ])

    expect(projectSystemActions(actions)).toEqual([
      {id: "open", description: "Open.", lifecycle: "persistent"},
    ])
    expect(projectSystemActions(actions, false)).toEqual([])
  })
})
