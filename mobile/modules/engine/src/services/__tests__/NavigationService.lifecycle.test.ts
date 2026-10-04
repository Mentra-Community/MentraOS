/// <reference types="bun-types" />

import {expect, mock, test} from "bun:test"

let startResult: Promise<{ok: boolean}> = Promise.resolve({ok: true})
let stopResult: Promise<{ok: boolean}> = Promise.resolve({ok: true})
mock.module("@mentra/crust", () => ({
  default: {
    addListener: () => ({remove: () => {}}),
    startNavigation: () => startResult,
    stopNavigation: () => stopResult,
  },
}))
const {default: navigation} = await import("../NavigationService")

test("late startup completion cannot resurrect a stopped trip snapshot", async () => {
  let resolveStart!: (result: {ok: boolean}) => void
  startResult = new Promise((resolve) => {
    resolveStart = resolve
  })
  const starting = navigation.start({lat: 1, lng: 2})
  await navigation.stop()
  resolveStart({ok: true})
  await starting
  expect(navigation.getState()).toBe("idle")
  expect(navigation.getSnapshot()).toBeNull()
})

test("late stop completion cannot clear a newer trip snapshot", async () => {
  let resolveStop!: (result: {ok: boolean}) => void
  stopResult = new Promise((resolve) => {
    resolveStop = resolve
  })
  const stopping = navigation.stop()
  startResult = Promise.resolve({ok: true})
  await navigation.start({lat: 3, lng: 4})
  resolveStop({ok: true})
  await stopping
  expect(navigation.getState()).toBe("navigating")
  expect(navigation.getSnapshot()?.stops).toEqual([{lat: 3, lng: 4}])
})
