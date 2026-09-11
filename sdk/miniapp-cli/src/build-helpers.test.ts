import {describe, expect, test} from "bun:test"

import {findUnsupportedBackgroundApis} from "./build-helpers"

describe("background runtime guard", () => {
  test("reports browser and Node globals with actionable replacements", () => {
    const findings = findUnsupportedBackgroundApis(`
      import {readFile} from "node:fs/promises"
      const started = performance.now()
      document.querySelector("main")
      const digest = crypto.subtle.digest("SHA-256", new Uint8Array())
      void readFile
      void started
      void digest
    `)

    expect(findings.map(({api}) => api)).toEqual(["node:fs/promises", "performance", "document", "crypto.subtle"])
    expect(findings.find(({api}) => api === "performance")?.replacement).toContain("Date.now()")
  })

  test("allows the documented background runtime and ordinary property names", () => {
    const findings = findUnsupportedBackgroundApis(`
      interface Metrics { performance: number }
      import type {Stats} from "node:fs"
      import {type BufferEncoding} from "node:buffer"
      export type {PathLike} from "node:fs"
      export {type PathLike as FilePath} from "node:fs"
      const metrics = {performance: Date.now()}
      const bytes = new TextEncoder().encode("hello")
      const id = crypto.randomUUID()
      setTimeout(() => console.log(id, metrics.performance, bytes), 10)
      void fetch("https://example.com", {headers: {"Content-Type": "application/json"}})
    `)

    expect(findings).toEqual([])
  })

  test("reports value re-exports from Node built-ins", () => {
    const findings = findUnsupportedBackgroundApis(`
      export {readFile} from "node:fs/promises"
      export * from "fs"
    `)

    expect(findings.map(({api}) => api)).toEqual(["node:fs/promises", "fs"])
  })

  test("allows public env values that the scaffold build inlines", () => {
    const findings = findUnsupportedBackgroundApis(`
      const apiUrl = process.env.MENTRA_PUBLIC_API_URL
      void fetch(apiUrl)
    `)

    expect(findings).toEqual([])
  })

  test("rejects process access that the scaffold cannot inline", () => {
    const findings = findUnsupportedBackgroundApis(`
      const secret = process.env.API_SECRET
      const env = process.env
      void secret
      void env
    `)

    expect(findings.map(({api}) => api)).toEqual(["process", "process"])
  })

  test("does not mistake local bindings for runtime globals", () => {
    const findings = findUnsupportedBackgroundApis(`
      const location = {latitude: 1, longitude: 2}
      const crypto = {subtle: "local"}
      function report(performance: number) {
        return {location, performance, subtle: crypto.subtle}
      }
      void report(1)
    `)

    expect(findings).toEqual([])
  })

  test("reports unsupported APIs accessed through global objects", () => {
    const findings = findUnsupportedBackgroundApis(`
      globalThis.performance.now()
      self.document.querySelector("main")
      void globalThis.crypto.subtle
    `)

    expect(findings.map(({api}) => api)).toEqual([
      "globalThis.performance",
      "self.document",
      "globalThis.crypto.subtle",
    ])
  })

  test("allows shadowed global-object names", () => {
    const findings = findUnsupportedBackgroundApis(`
      function read(globalThis: {performance: number}, self: {document: string}) {
        return [globalThis.performance, self.document]
      }
      void read
    `)

    expect(findings).toEqual([])
  })
})
