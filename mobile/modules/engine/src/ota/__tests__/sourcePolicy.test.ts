import {expect, test} from "bun:test"
import {resolveFirmwareSource} from "../sourcePolicy"

const bundled = {url: "https://example.invalid/release.json", sha256: "a".repeat(64)}
const replacement = {url: "https://workspace.invalid/release.json", sha256: "b".repeat(64)}

test("device source omission, replacement and explicit disable are distinct", () => {
  expect(resolveFirmwareSource("nimo", undefined, bundled)).toEqual(bundled)
  expect(resolveFirmwareSource("nimo", {sources: {nimo: null}}, bundled)).toBeNull()
  expect(resolveFirmwareSource("nimo", {allowBundled: false}, bundled)).toBeNull()
  expect(resolveFirmwareSource("nimo", {allowBundled: false, sources: {nimo: replacement}}, bundled)).toEqual(
    replacement,
  )
  expect(resolveFirmwareSource("nimo", {sources: {another: replacement}}, null)).toBeNull()
})

test("source policy validates replacement pins and never inherits prototype entries", () => {
  for (const pin of [
    {...bundled, sha256: ""},
    {...bundled, url: "http://example.invalid/a"},
    {...bundled, url: "https://user:password@example.invalid/a"},
  ]) {
    expect(() => resolveFirmwareSource("nimo", {sources: {nimo: pin}}, bundled)).toThrow()
  }
  expect(resolveFirmwareSource("nimo", {sources: Object.create({nimo: replacement})}, bundled)).toEqual(bundled)
})
