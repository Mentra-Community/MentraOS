import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"

// Doppler owns application settings (docs/runbooks/doppler/porter-integration.md), so
// Core's Store URL comes from each Cloud V2 app's linked Doppler group. The hourly
// Doppler Porter health audit requires every key the contract lists for that group.
const contract = JSON.parse(
  readFileSync(new URL("../../../../.github/production-release/doppler-porter-contract.json", import.meta.url), "utf8"),
) as {groups: Array<{name: string; keys: string[]}>}

test.each(["porter.yaml", "porter.dev.yaml", "porter.staging.yaml", "porter.prod.yaml", "porter.debug.yaml", "porter.isaiah.yaml"])(
  "%s configures Core's Store URL through its Doppler group, not a Porter override",
  (file) => {
    const config = Bun.YAML.parse(readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8")) as {
      env?: Record<string, string>; envGroups?: string[]; services: Array<{env?: Record<string, string>}>
    }
    expect(config.env).toBeUndefined()
    expect(config.services.every(service => service.env === undefined)).toBe(true)
    expect(config.envGroups).toHaveLength(1)
    const group = contract.groups.find(candidate => candidate.name === config.envGroups?.[0])
    // Core needs the Store's package-count secret whenever it has a Store URL.
    expect(group?.keys).toEqual(expect.arrayContaining(["MENTRA_STORE_INTERNAL_URL", "CLOUD_CORE_STORE_SERVICE_SECRET"]))
  },
)
