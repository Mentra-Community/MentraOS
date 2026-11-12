/// <reference types="bun-types" />

import {afterAll, beforeEach, expect, mock, test} from "bun:test"

import {bluetoothSdk} from "./bluetoothSdkTestMock"

const listeners = new Map<string, (event: Record<string, unknown>) => unknown>()
Object.assign(bluetoothSdk, {
  addListener: (name: string, listener: (event: Record<string, unknown>) => unknown) => {
    listeners.set(name, listener)
    return {remove: () => listeners.delete(name)}
  },
})

const forwarded: Array<[string, unknown]> = []
let wakeWordSubscribers = 0
mock.module("../LocalMiniappRuntime", () => ({
  default: {
    forwardEvent: (stream: string, data: unknown) => forwarded.push([stream, data]),
    hasStreamSubscribers: (stream: string) => stream === "wake_word" && wakeWordSubscribers > 0,
  },
}))
mock.module("../LocalSttFallbackCoordinator", () => ({default: {}}))
const prepareForPlayback = mock(async () => {})
mock.module("../AudioPlaybackService", () => ({default: {prepareForPlayback}}))
let forwardWakeEvents = true
mock.module("../WakeWordService", () => ({
  wakeWordService: {onNativeEvent: (event: unknown) => (forwardWakeEvents ? event : null)},
}))
mock.module("../PhonePhotoCoordinator", () => ({phonePhotoCoordinator: {}}))
mock.module("../PhoneStreamCoordinator", () => ({phoneStreamCoordinator: {}}))
mock.module("../GlassesReadiness", () => ({isGlassesConnected: () => false}))
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {getState: () => ({}), subscribe: () => () => {}},
}))
mock.module("../../stores/settings", () => ({useSettingsStore: {getState: () => ({})}}))
mock.module("../../stores/apps", () => ({useAppStatusStore: {getState: () => ({apps: []})}}))
mock.module("../PairingIdentity", () => ({retirePendingSelectionOnPromotion: () => {}}))
mock.module("../../utils/GlobalEventEmitter", () => ({default: {emit: () => {}}}))
mock.module("../asg/asgCameraApi", () => ({asgCameraApi: {}}))

const {startDeviceEventRouter, stopDeviceEventRouter} = await import("../DeviceEventRouter")

beforeEach(() => {
  stopDeviceEventRouter()
  listeners.clear()
  forwarded.length = 0
  prepareForPlayback.mockClear()
  wakeWordSubscribers = 0
  forwardWakeEvents = true
  startDeviceEventRouter()
})

afterAll(stopDeviceEventRouter)

test("native speech activity reaches miniapps as one vad event per transition", () => {
  listeners.get("speech_activity")?.({speaking: true, silentForMs: 0, timestamp: 10})
  listeners.get("speech_activity")?.({speaking: false, silentForMs: 300, timestamp: 900})
  expect(forwarded).toEqual([
    ["vad", {status: true, silentForMs: 0, timestamp: 10}],
    ["vad", {status: false, silentForMs: 300, timestamp: 900}],
  ])
  // Raw microphone PCM no longer produces vad events in JavaScript.
  expect(listeners.has("mic_pcm")).toBe(false)
})

test("any wake-word detection with subscribers warms up playback", () => {
  const detected = {kind: "detected", phrase: "Hey Mentra", timestamp: 1}
  listeners.get("wake_word")?.(detected)
  expect(prepareForPlayback).not.toHaveBeenCalled()
  wakeWordSubscribers = 1
  listeners.get("wake_word")?.(detected)
  listeners.get("wake_word")?.({kind: "ready", phrase: "Hey Mentra", timestamp: 2})
  expect(prepareForPlayback).toHaveBeenCalledTimes(1)
  expect(forwarded.filter(([stream]) => stream === "wake_word")).toHaveLength(3)
})

test("wake-word events the service holds back are not forwarded", () => {
  forwardWakeEvents = false
  listeners.get("wake_word")?.({kind: "ready", phrase: "Hey Mentra", timestamp: 2})
  expect(forwarded).toEqual([])
})
