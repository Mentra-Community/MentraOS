import {describe, expect, test} from "bun:test"

import {MiniappConfigurationError} from "./modules/configuration"
import {MiniappSession} from "./session"
import {MockTransport} from "./transport/mock"

describe("session.configuration", () => {
  test("reads package configuration from CONNECT_ACK without another request", async () => {
    const session = new MiniappSession({
      packageName: "com.example.remoteassist",
      transport: new MockTransport({
        silent: true,
        configuration: {backendUrl: "https://customer.example/api"},
      }),
    })

    await expect(session.configuration.get("backendUrl")).resolves.toBe("https://customer.example/api")
    await expect(session.configuration.get("missing")).resolves.toBeUndefined()
    session.disconnect()
  })

  test("requires configured values with a typed error", async () => {
    const session = new MiniappSession({transport: new MockTransport({silent: true})})

    await expect(session.configuration.require("backendUrl")).rejects.toBeInstanceOf(MiniappConfigurationError)
    session.disconnect()
  })

  test("returns defensive snapshots", async () => {
    const session = new MiniappSession({
      transport: new MockTransport({silent: true, configuration: {backendUrl: "https://customer.example"}}),
    })

    const first = (await session.configuration.getAll()) as Record<string, string>
    first.backendUrl = "https://attacker.example"

    await expect(session.configuration.get("backendUrl")).resolves.toBe("https://customer.example")
    session.disconnect()
  })
})
