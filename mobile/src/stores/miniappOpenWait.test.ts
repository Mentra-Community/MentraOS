import type {ClientApp} from "@mentra/engine"

import {
  endMiniappOpenWait,
  miniappOpenWaitPhase,
  startMiniappOpenWait,
  useMiniappOpenWaitStore,
} from "./miniappOpenWait"

const app = (fields: Partial<ClientApp> = {}) =>
  ({packageName: "com.mentra.ai", name: "Mentra AI", logoUrl: "https://host/icon.png", ...fields}) as ClientApp

const defaults = (
  fields: {status?: "idle" | "installing" | "waiting"; pending?: string[]; failed?: string[]} = {},
) => ({
  status: "installing" as const,
  pending: ["com.mentra.ai"],
  failed: [],
  ...fields,
})

describe("miniappOpenWaitPhase", () => {
  it("opens an installed miniapp once it isn't updating", () => {
    expect(miniappOpenWaitPhase("com.mentra.ai", app(), defaults())).toBe("ready")
    expect(miniappOpenWaitPhase("com.mentra.ai", app({updating: true}), defaults())).toBe("updating")
  })

  it("waits for a default that is installing, or whose download waits for a connection", () => {
    expect(miniappOpenWaitPhase("com.mentra.ai", undefined, defaults())).toBe("installing")
    expect(miniappOpenWaitPhase("com.mentra.ai", undefined, defaults({status: "waiting"}))).toBe("waiting")
  })

  it("says a default won't install once its install was refused, or it left the list", () => {
    expect(miniappOpenWaitPhase("com.mentra.ai", undefined, defaults({pending: [], failed: ["com.mentra.ai"]}))).toBe(
      "failed",
    )
    expect(miniappOpenWaitPhase("com.mentra.ai", undefined, defaults({status: "idle", pending: []}))).toBe("failed")
  })
})

describe("the open wait", () => {
  it("names the miniapp and its icon, and only its own end clears it", () => {
    const open = jest.fn(async () => {})
    startMiniappOpenWait(app(), open)
    const first = useMiniappOpenWaitStore.getState().wait!
    expect(first).toMatchObject({packageName: "com.mentra.ai", name: "Mentra AI", iconUrl: "https://host/icon.png"})

    startMiniappOpenWait(app({packageName: "com.mentra.notes", name: "Notes", logoUrl: ""}), open)
    const second = useMiniappOpenWaitStore.getState().wait!
    expect(second.iconUrl).toBeUndefined()

    endMiniappOpenWait(first.id)
    expect(useMiniappOpenWaitStore.getState().wait).toBe(second)
    endMiniappOpenWait(second.id)
    expect(useMiniappOpenWaitStore.getState().wait).toBeNull()
  })
})
