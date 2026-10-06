import {Platform, type View} from "react-native"
import {captureRef} from "react-native-view-shot"

import Crust from "@mentra/crust"

import {captureMiniappPreview} from "./captureMiniappPreview"

jest.mock("@mentra/crust", () => ({__esModule: true, default: {captureMiniappPreview: jest.fn()}}))
jest.mock("react-native-view-shot", () => ({captureRef: jest.fn()}))

const viewRef = {current: {} as View}
const nativeCapture = jest.mocked(Crust.captureMiniappPreview)
const softwareCapture = jest.mocked(captureRef)

afterEach(() => {
  jest.restoreAllMocks()
  jest.resetAllMocks()
})

test("Android copies window pixels and propagates capture failure without software fallback", async () => {
  jest.replaceProperty(Platform, "OS", "android")
  jest.spyOn(require("react-native"), "findNodeHandle").mockReturnValue(42)
  nativeCapture.mockResolvedValueOnce("file:///cache/preview.jpg")
  await expect(captureMiniappPreview(viewRef)).resolves.toBe("file:///cache/preview.jpg")
  expect(nativeCapture).toHaveBeenCalledWith(42)

  nativeCapture.mockRejectedValueOnce(new Error("PixelCopy failed"))
  await expect(captureMiniappPreview(viewRef)).rejects.toThrow("PixelCopy failed")
  expect(softwareCapture).not.toHaveBeenCalled()
})

test("a missing Android view cannot capture unrelated window content", async () => {
  jest.replaceProperty(Platform, "OS", "android")
  jest.spyOn(require("react-native"), "findNodeHandle").mockReturnValue(null)
  await expect(captureMiniappPreview({current: null})).rejects.toThrow("view is unavailable")
  expect(nativeCapture).not.toHaveBeenCalled()
})

test("iOS retains its existing capture strategy and quality", async () => {
  jest.replaceProperty(Platform, "OS", "ios")
  softwareCapture.mockResolvedValueOnce("file:///cache/ios.jpg")
  await expect(captureMiniappPreview(viewRef)).resolves.toBe("file:///cache/ios.jpg")
  expect(softwareCapture).toHaveBeenCalledWith(viewRef, {format: "jpg", quality: 0.1, result: "tmpfile"})
  expect(nativeCapture).not.toHaveBeenCalled()
})
