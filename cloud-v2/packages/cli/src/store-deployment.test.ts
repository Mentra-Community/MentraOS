import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {DEFAULT_STORE_URL} from "./config"

test.each(["porter.yaml", "porter.dev.yaml", "porter.staging.yaml", "porter.prod.yaml", "porter.debug.yaml", "porter.isaiah.yaml"])(
  "%s configures Core with the CLI's Store through Porter's supported application environment",
  (file) => {
    const config = Bun.YAML.parse(readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8")) as {
      env?: Record<string, string>; services: Array<{env?: Record<string, string>}>
    }
    expect(config.env?.MENTRA_STORE_INTERNAL_URL).toBe(DEFAULT_STORE_URL)
    expect(config.services.every(service => service.env?.MENTRA_STORE_INTERNAL_URL === undefined)).toBe(true)
  },
)
