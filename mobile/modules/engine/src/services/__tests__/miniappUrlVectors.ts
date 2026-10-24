/// <reference types="bun-types" />

import {readFileSync} from "node:fs"
import {dirname, join} from "node:path"

/** One case of the domain rule. */
export interface DomainRuleVector {
  packageName: string
  url: string
  allowed: boolean
}

/** The shared miniapp URL vectors, which Core's tests read too. */
export interface MiniappUrlVectors {
  normalize: Array<{input: string; expected: {url: string; host: string; kind: string} | null}>
  registrableDomain: Array<{host: string; expected: string | null}>
  packagePrefix: Array<{host: string; expected: string | null}>
  localNetwork: Array<{host: string; expected: boolean}>
  domainRule: DomainRuleVector[]
}

/** Read from the `@mentra/cloud-protocol` package this engine imports. */
export function miniappUrlVectors(): MiniappUrlVectors {
  const protocolSource = dirname(Bun.resolveSync("@mentra/cloud-protocol/miniapp-url", import.meta.dir))
  return JSON.parse(readFileSync(join(protocolSource, "__fixtures__", "miniapp-url-vectors.json"), "utf8"))
}

export function domainRuleVectors(): DomainRuleVector[] {
  return miniappUrlVectors().domainRule
}
