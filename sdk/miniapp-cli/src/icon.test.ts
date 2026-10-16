/// <reference types="bun-types" />

import {afterEach, describe, expect, test} from "bun:test"
import {copyFileSync, mkdtempSync, rmSync, writeFileSync} from "fs"
import os from "os"
import {join, resolve} from "path"
import {isPlaceholderIcon} from "./icon.js"

const TEMPLATE_ICON = resolve(import.meta.dir, "../../create-mentra-miniapp/template/icon.png")

describe("isPlaceholderIcon", () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, {recursive: true, force: true})
    dir = undefined
  })

  test("recognizes the icon create-mentra-miniapp scaffolds", () => {
    dir = mkdtempSync(join(os.tmpdir(), "miniapp-icon-"))
    copyFileSync(TEMPLATE_ICON, join(dir, "icon.png"))
    expect(isPlaceholderIcon(dir)).toBe(true)
  })

  test("accepts a replaced icon", () => {
    dir = mkdtempSync(join(os.tmpdir(), "miniapp-icon-"))
    writeFileSync(join(dir, "icon.png"), "not the placeholder")
    expect(isPlaceholderIcon(dir)).toBe(false)
  })

  test("ignores a missing icon", () => {
    dir = mkdtempSync(join(os.tmpdir(), "miniapp-icon-"))
    expect(isPlaceholderIcon(dir)).toBe(false)
  })
})
