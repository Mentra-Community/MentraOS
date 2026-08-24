/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappErrorCode, MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {ActionsModule} from "./actions"
import {MiniappsModule, type MiniappInfo} from "./miniapps"

function mockSession() {
  const requests: object[] = []
  const oneShots: object[] = []
  const session = {
    sendRequest: <T>(payload: object): Promise<T> => {
      requests.push(payload)
      return Promise.resolve(undefined as unknown as T)
    },
    sendOneShot: (payload: object) => {
      oneShots.push(payload)
    },
  } as unknown as MiniappSession
  return {session, requests, oneShots}
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("MiniappsModule (session.miniapps)", () => {
  test("list sends MINIAPPS_LIST (compatible-only by default)", async () => {
    const {session, requests} = mockSession()
    const result: MiniappInfo[] = [
      {
        packageName: "com.todo",
        name: "Todo",
        version: "1.0.0",
        running: false,
        compatibility: {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []},
        actions: [
          {
            id: "add_todo",
            description: "Add a todo.",
            parameters: {type: "object"},
            outputSchema: {type: "object", properties: {added: {type: "string"}}},
          },
        ],
      },
    ]
    ;(session.sendRequest as unknown) = (payload: object) => {
      requests.push(payload)
      return Promise.resolve(result)
    }
    const miniapps = new MiniappsModule(session)
    await expect(miniapps.list()).resolves.toEqual(result)
    expect(requests[0]).toEqual({type: MiniappRequestType.MINIAPPS_LIST, includeIncompatible: false})
  })

  test("list passes includeIncompatible through", async () => {
    const {session, requests} = mockSession()
    const miniapps = new MiniappsModule(session)
    await miniapps.list({includeIncompatible: true})
    expect(requests[0]).toEqual({type: MiniappRequestType.MINIAPPS_LIST, includeIncompatible: true})
  })

  test("start / open / stop send lifecycle requests with the packageName", async () => {
    const {session, requests} = mockSession()
    const miniapps = new MiniappsModule(session)
    await miniapps.start("com.todo")
    await miniapps.open("com.todo")
    await miniapps.stop("com.todo")
    expect(requests).toEqual([
      {type: MiniappRequestType.MINIAPPS_START, packageName: "com.todo"},
      {type: MiniappRequestType.MINIAPPS_START, packageName: "com.todo", foreground: true},
      {type: MiniappRequestType.MINIAPPS_STOP, packageName: "com.todo"},
    ])
  })
})

describe("ActionsModule (session.actions)", () => {
  test("invoke sends ACTION_INVOKE with params + timeout", async () => {
    const {session, requests} = mockSession()
    const actions = new ActionsModule(session)
    await actions.invoke("com.todo", "add_todo", {text: "milk"}, {timeoutMs: 5000})
    expect(requests[0]).toEqual({
      type: MiniappRequestType.ACTION_INVOKE,
      targetPackageName: "com.todo",
      actionId: "add_todo",
      params: {text: "milk"},
      timeoutMs: 5000,
    })
  })

  test("handle + _deliver runs the handler and replies with the result", async () => {
    const {session, oneShots} = mockSession()
    const actions = new ActionsModule(session)
    actions.handle("add_todo", async (params, ctx) => ({added: params.text, by: ctx.callerPackageName}))
    actions._deliver("call-1", "add_todo", {text: "milk"}, {callerPackageName: "com.mentra.ai"})
    await tick()
    expect(oneShots).toEqual([
      {
        type: MiniappRequestType.ACTION_RESULT,
        callId: "call-1",
        ok: true,
        result: {added: "milk", by: "com.mentra.ai"},
      },
    ])
  })

  test("_deliver before handle buffers, then dispatches once the handler registers", async () => {
    const {session, oneShots} = mockSession()
    const actions = new ActionsModule(session)
    actions._deliver("call-2", "later", {}, {callerPackageName: "com.mentra.ai"})
    await tick()
    expect(oneShots).toEqual([]) // buffered — no reply yet
    actions.handle("later", () => "done")
    await tick()
    expect(oneShots).toEqual([{type: MiniappRequestType.ACTION_RESULT, callId: "call-2", ok: true, result: "done"}])
  })

  test("double-register throws synchronously", () => {
    const {session} = mockSession()
    const actions = new ActionsModule(session)
    actions.handle("x", () => undefined)
    expect(() => actions.handle("x", () => undefined)).toThrow(/already registered/)
  })

  test("a throwing handler replies with an INTERNAL error", async () => {
    const {session, oneShots} = mockSession()
    const actions = new ActionsModule(session)
    actions.handle("boom", () => {
      throw new Error("nope")
    })
    actions._deliver("call-3", "boom", {}, {callerPackageName: "com.mentra.ai"})
    await tick()
    expect(oneShots[0]).toMatchObject({
      type: MiniappRequestType.ACTION_RESULT,
      callId: "call-3",
      ok: false,
      error: {code: MiniappErrorCode.INTERNAL},
    })
  })

  test("unsubscribe removes the handler", () => {
    const {session} = mockSession()
    const actions = new ActionsModule(session)
    const off = actions.handle("y", () => undefined)
    off()
    // re-registering after unsubscribe must not throw
    expect(() => actions.handle("y", () => undefined)).not.toThrow()
  })
})
