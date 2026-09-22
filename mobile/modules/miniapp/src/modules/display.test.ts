/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {DisplayManager, type RenderResult} from "./display"

describe("conditional display updates", () => {
  test("forwards the token and returns the host's replacement token", async () => {
    const calls: unknown[] = []
    const session = {
      sendRequest: async (payload: unknown): Promise<RenderResult> => {
        calls.push(payload)
        return {status: "displayed", displayToken: "next"}
      },
    } as unknown as MiniappSession
    expect(await new DisplayManager(session).render([], {ifDisplayToken: "previous"})).toEqual({
      status: "displayed",
      displayToken: "next",
    })
    expect(calls).toEqual([
      {type: MiniappRequestType.RENDER, view: "main", elements: [], durationMs: undefined, ifDisplayToken: "previous"},
    ])
  })
  test("preserves blocked outcomes and older hosts without tokens", async () => {
    for (const result of [{status: "blocked", reason: "display frame changed"}, {status: "displayed"}]) {
      const session = {sendRequest: async () => result} as unknown as MiniappSession
      expect(await new DisplayManager(session).render([])).toEqual(result)
    }
  })
})
