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
      const metrics = {performance: Date.now()}
      const bytes = new TextEncoder().encode("hello")
      const id = crypto.randomUUID()
      setTimeout(() => console.log(id, metrics.performance, bytes), 10)
      void fetch("https://example.com", {headers: {"Content-Type": "application/json"}})
    `)

    expect(findings).toEqual([])
  })
})
