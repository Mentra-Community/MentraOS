import {describe, expect, test} from "bun:test"

import {MiniappConfigurationError} from "./modules/configuration"
import {MiniappResponseType} from "./protocol"
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

  test("does not expose inherited object properties as configuration", async () => {
    const session = new MiniappSession({
      transport: new MockTransport({silent: true, configuration: {backendUrl: "https://customer.example"}}),
    })

    await expect(session.configuration.get("toString")).resolves.toBeUndefined()
    expect(Object.getPrototypeOf(await session.configuration.getAll())).toBeNull()
    session.disconnect()
  })

  test("tells handlers which keys changed when the host pushes new values, with their source", async () => {
    const transport = new MockTransport({
      silent: true,
      configuration: {defaultMode: "Manual"},
      configurationSources: {defaultMode: "shipped"},
    })
    const session = new MiniappSession({transport})
    await expect(session.configuration.source("defaultMode")).resolves.toBe("shipped")

    const changed = new Promise<string[]>((resolve) => session.configuration.onChange(resolve))
    transport.push({
      type: MiniappResponseType.CONFIGURATION_UPDATE,
      configuration: {defaultMode: "DVI", modes: [{name: "DVI", source: "workspace"}]},
      configurationSources: {defaultMode: "workspace", modes: "workspace"},
    })
    await expect(changed).resolves.toEqual(["defaultMode", "modes"])
    await expect(session.configuration.get("defaultMode")).resolves.toBe("DVI")
    await expect(session.configuration.source("defaultMode")).resolves.toBe("workspace")
    session.disconnect()
  })
  test("tells handlers when a file a key names is back, its value unchanged", async () => {
    const form = {name: "dvi.xlsx", type: "", size: 1, sha256: "a".repeat(64)}
    const transport = new MockTransport({silent: true, configuration: {modes: [{name: "DVI", form}], other: "x"}})
    const session = new MiniappSession({transport})
    await session.configuration.getAll()
    const changed = new Promise<string[]>((resolve) => session.configuration.onChange(resolve))
    transport.push({
      type: MiniappResponseType.CONFIGURATION_UPDATE,
      configuration: {modes: [{name: "DVI", form}], other: "x"},
      configurationFiles: [form.sha256],
    })
    await expect(changed).resolves.toEqual(["modes"])
    session.disconnect()
  })
})
