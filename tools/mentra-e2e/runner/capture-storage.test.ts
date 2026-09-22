import {expect, test} from "bun:test"
import {assertCaptureStorage} from "./report"

const GiB = 1024 ** 3

test("roomy external output cannot hide system-volume pressure observed in the failed Mac run", () => {
  expect(() => assertCaptureStorage(100 * GiB, 10_930_237_440)).toThrow("20 GiB")
})

test("capture requires both reserves and accepts their exact boundaries", () => {
  expect(() => assertCaptureStorage(5 * GiB, 20 * GiB)).not.toThrow()
  expect(() => assertCaptureStorage(5 * GiB - 1, 100 * GiB)).toThrow("5 GiB")
  expect(() => assertCaptureStorage(100 * GiB, 20 * GiB - 1)).toThrow("20 GiB")
})

test("unreadable numeric observations cannot satisfy a storage reserve", () => {
  expect(() => assertCaptureStorage(Number.NaN, 100 * GiB)).toThrow("5 GiB")
  expect(() => assertCaptureStorage(100 * GiB, Number.NaN)).toThrow("20 GiB")
})

test("non-macOS capture retains the artifact reserve without requiring a macOS volume", () => {
  expect(() => assertCaptureStorage(5 * GiB)).not.toThrow()
  expect(() => assertCaptureStorage(5 * GiB - 1)).toThrow("5 GiB")
})
