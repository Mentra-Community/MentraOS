import {expect, test} from "bun:test"
import {LiveEventContext} from "../eventContext"

test("Live events retain native identity without rejecting valid SID changes on the same connection", () => {
  const context = new LiveEventContext()
  const event = {source_device_id: "live-a", source_connection_generation: 2}
  expect(context.accepts(event, "live-a")).toBe(true)
  expect(context.accepts(event, "live-a")).toBe(true)
  expect(context.accepts(event, "live-b")).toBe(false)
  expect(context.accepts({...event, source_connection_generation: 1}, "live-a")).toBe(false)
  expect(context.accepts({...event, source_connection_generation: 3}, "live-a")).toBe(true)
  expect(context.accepts({source_device_id: "live-a"}, "live-a")).toBe(false)
  expect(context.accepts({}, "live-a")).toBe(true)
})
