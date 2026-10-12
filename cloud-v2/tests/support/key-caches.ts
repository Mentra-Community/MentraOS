/**
 * @fileoverview Core's key caches, for suites that change the signing keys.
 *
 * Core caches its signing keys (`signing-keys.service`) and the shared verifier
 * caches the access-token public key (`@mentra/cloud-shared`); each is read
 * from `MENTRA_JWT_*` on first use. Bun runs the test files of one command in
 * one process, in an order that changes from run to run. A suite that sets
 * `MENTRA_JWT_*` therefore resets both caches when it sets the keys and again
 * when it is done with them: otherwise a later suite signs with one suite's
 * private key and verifies with another suite's public key, and every access
 * token it issues is refused.
 */

import {resetMentraKeyCache} from "../../packages/shared/src/auth"
import {resetSigningKeyCache} from "../../packages/core/src/services/signing-keys.service"

export function resetCoreKeyCaches(): void {
  resetSigningKeyCache()
  resetMentraKeyCache()
}
