/**
 * @fileoverview Membership rows for tests that insert them directly.
 *
 * Core records every role a membership holds in `roleHistory`, starting with the role it was created
 * with, and the model refuses a row without it. A fixture that writes a row by hand gets that first
 * entry here: its role from its `startedAt`, at revision 0, unless it gives its own `roleHistory`.
 */
export function membershipRow<T extends {role: string; startedAt: Date}>(row: T): T & {roleHistory: unknown[]} {
  return {roleHistory: [{role: row.role, from: row.startedAt, authorizationRevision: 0}], ...row}
}
