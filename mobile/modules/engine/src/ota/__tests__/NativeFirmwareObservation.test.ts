import {expect, test} from "bun:test"
import type {NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"
import {NativeFirmwareObservation} from "../NativeFirmwareObservation"

const identity = {deviceId: "native-device", integrationId: "nimo"}
const snapshot = (patch: Partial<NativeFirmwareUpdateSnapshot> = {}): NativeFirmwareUpdateSnapshot => ({
  ...identity,
  schemaVersion: 1,
  updaterId: "sgc-1",
  connectionGeneration: 1,
  revision: 0,
  phase: "idle",
  safeToRelease: true,
  canCancel: false,
  canReconcile: false,
  inventory: {},
  ...patch,
})

test("subscription is installed before the read and newer buffered events win", async () => {
  const values: number[] = []
  let resolve!: (value: NativeFirmwareUpdateSnapshot) => void
  let listener!: (value: NativeFirmwareUpdateSnapshot) => void
  const observer = new NativeFirmwareObservation(
    identity,
    {
      listen: (callback) => {
        listener = callback
        return () => {}
      },
      read: () => {
        expect(listener).toBeDefined()
        return new Promise((done) => {
          resolve = done
        })
      },
    },
    (value) => values.push(value.revision),
    () => {},
  )
  const started = observer.start()
  listener(snapshot({revision: 3}))
  listener(snapshot({revision: 4, deviceId: "another-device"}))
  resolve(snapshot({revision: 1}))
  await started
  listener(snapshot({revision: 2}))
  listener(snapshot({revision: 5}))
  expect(values).toEqual([3, 5])
})

test("replacement arriving during an old read is reconciled and late old events are ignored", async () => {
  let listener!: (value: NativeFirmwareUpdateSnapshot) => void
  let resolve!: (value: NativeFirmwareUpdateSnapshot) => void
  let reads = 0
  const values: string[] = []
  const next = snapshot({updaterId: "sgc-2", connectionGeneration: 2, revision: 2})
  const observer = new NativeFirmwareObservation(
    identity,
    {
      listen: (callback) => {
        listener = callback
        return () => {}
      },
      read: () =>
        ++reads === 1
          ? new Promise((done) => {
              resolve = done
            })
          : Promise.resolve(next),
    },
    (value) => values.push(value.updaterId),
    () => {},
  )
  const started = observer.start()
  listener(next)
  resolve(snapshot())
  await started
  listener(snapshot({revision: 100}))
  expect(values).toEqual(["sgc-1", "sgc-2"])
  expect(reads).toBe(2)
})

test("disposed reads cannot publish and unconfirmed updater events cannot force endless polling", async () => {
  let listener!: (value: NativeFirmwareUpdateSnapshot) => void
  let reads = 0
  const observer = new NativeFirmwareObservation(
    identity,
    {
      listen: (callback) => {
        listener = callback
        return () => {}
      },
      read: async () => {
        reads++
        return snapshot()
      },
    },
    () => {},
    () => {},
  )
  await observer.start()
  listener(snapshot({updaterId: "unconfirmed", connectionGeneration: 100}))
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(observer.snapshot()?.updaterId).toBe("sgc-1")
  expect(reads).toBe(2)
  observer.dispose()
  listener(snapshot({revision: 200}))
  expect(observer.snapshot()?.revision).toBe(0)
})
