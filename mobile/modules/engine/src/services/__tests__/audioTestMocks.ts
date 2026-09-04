/// <reference types="bun-types" />

import {mock} from "bun:test"

type Lc3Event = {lc3: number[]}

let onLc3Frame: ((event: Lc3Event) => void) | null = null

export const removeAudioListener = mock(() => {})
export const addAudioListener = mock((_event: string, listener: (event: Lc3Event) => void) => {
  onLc3Frame = listener
  return {remove: removeAudioListener}
})
export const getGlassesMediaVolume = mock(async () => ({level: 10, statusCode: 0}))
export const pcmStreamOpen = mock(async () => {})
export const pcmStreamWrite = mock(async () => ({bufferedMs: 120}))
export const pcmStreamClose = mock(async () => ({durationMs: 1_500}))
export const pcmStreamAbort = mock(async () => {})
export const setGlassesMediaVolume = mock(async () => ({level: 10, statusCode: 0}))
export const setOwnAppAudioPlaying = mock(async () => {})
export const sendAudioFrame = mock(() => {})
export const setCameraFovOverride = mock(async (request: Record<string, unknown>) => ({
  requestId: "ack-1",
  fov: "preset" in request ? (request.preset === "wide" ? 118 : 102) : request.fov,
  roiPosition: "preset" in request ? "center" : request.roiPosition ?? "center",
  timestamp: 1,
}))
export const releaseCameraFovOverride = mock(async (_leaseId: string) => ({ready: true}))
export const restoreLegacyCameraFov = mock(async () => {})
export const setLegacyCameraFov = mock(async (request: Record<string, unknown>) => ({
  requestId: "legacy",
  fov: request.fov,
  roiPosition: request.roiPosition ?? "center",
  timestamp: 1,
}))
export const updateBluetoothSettings = mock(async (_patch: Record<string, unknown>) => {})

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: {
    addListener: addAudioListener,
    getGlassesMediaVolume,
    pcmStreamAbort,
    pcmStreamClose,
    pcmStreamOpen,
    pcmStreamWrite,
    releaseCameraFovOverride,
    restoreLegacyCameraFov,
    setCameraFovOverride,
    setGlassesMediaVolume,
    setLegacyCameraFov,
    setOwnAppAudioPlaying,
    updateBluetoothSettings,
  },
}))

mock.module("../CloudClientService", () => ({
  cloudClientService: {
    hasAudioSubscriptions: () => true,
    isConnected: () => true,
    sendAudioFrame,
  },
}))

export function emitLc3Frame(lc3: number[]): void {
  onLc3Frame?.({lc3})
}

export function resetAudioTestMocks(): void {
  onLc3Frame = null
  addAudioListener.mockClear()
  removeAudioListener.mockClear()
  getGlassesMediaVolume.mockClear()
  pcmStreamAbort.mockClear()
  pcmStreamClose.mockClear()
  pcmStreamOpen.mockClear()
  pcmStreamWrite.mockClear()
  setGlassesMediaVolume.mockClear()
  setOwnAppAudioPlaying.mockClear()
  sendAudioFrame.mockClear()
  setCameraFovOverride.mockClear()
  releaseCameraFovOverride.mockClear()
  restoreLegacyCameraFov.mockClear()
  setLegacyCameraFov.mockClear()
  updateBluetoothSettings.mockClear()
}
